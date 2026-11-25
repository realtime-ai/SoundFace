const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudSession } = require('../app/cloud-session.cjs');
const { ProxyBackend } = require('../app/cloud-backend.cjs');
const http = require('node:http');

// Minimal stand-in for the Workers API contract (workers/src/index.js), so the
// client can be tested without workerd. The real server is tested in workers/test.
async function contractServer(t, { now }) {
  const state = { balance: 600, token: 'tok-' + Math.random(), session: null, frames: 0, firstFrameAt: null, code: null };
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; body = body ? JSON.parse(body) : {};
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    const account = () => ({ id: 'x', name: state.name, remainingSeconds: state.balance, remainingMinutes: Math.floor(state.balance / 60) });
    const authed = request.headers.authorization === 'Bearer ' + state.token;
    const url = request.url;
    if (url === '/v1/auth/dev/login') { state.name = body.name; return send(200, { token: state.token, account: account() }); }
    if (url === '/v1/auth/sms/code') return /^1\d{10}$/.test(body.phone || '') ? send(200, { resendAfterSeconds: 60 }) : send(400, { code: 'BAD_PHONE', message: '请输入 11 位手机号' });
    if (url === '/v1/auth/sms/login') { if (body.code !== '000000') return send(400, { code: 'CODE_WRONG', message: '验证码不正确' }); state.name = '138****8000'; return send(200, { token: state.token, account: account() }); }
    if (!authed) return send(401, { code: 'UNAUTHENTICATED', message: '请先登录' });
    if (url === '/v1/me') return send(200, account());
    if (url === '/v1/redeem') { if (body.code !== 'SF-GOOD') return send(400, { code: 'REDEEM_INVALID', message: '兑换码无效、已被使用或已过期' }); state.balance += 99 * 60; return send(200, { credits: 99, account: account() }); }
    if (url === '/v1/history') return send(200, { purchases: [], sessions: [] });
    if (url === '/v1/sessions') { state.session = 'sess-1'; return send(200, { sessionId: 'sess-1', provider: 'fake', transport: { type: 'fake' }, control: { type: 'none' } }); }
    if (url === '/v1/sessions/sess-1/heartbeat') { if (body.frames > 0 && !state.firstFrameAt) state.firstFrameAt = now(); return send(200, { state: 'active', remainingSeconds: state.balance }); }
    if (url === '/v1/sessions/sess-1/hangup') { const billed = state.firstFrameAt ? Math.floor((now() - state.firstFrameAt) / 1000) : 0; state.balance -= billed; return send(200, { state: 'ended', billedSeconds: billed }); }
    send(404, { code: 'NOT_FOUND' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, state };
}

// Scripted backend for lifecycle edge cases.
function fixture({ holdCreate = false, holdInit = false, ended = true, rejectCreate = false, control = 'vidu-ws', image = () => 'data:image/jpeg;base64,reference', characterExists } = {}) {
  const calls = [], signals = []; let release;
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(text) {
      const data = JSON.parse(text); signals.push(data);
      if (data.type === 1 && !holdInit) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 2, payload: { conn_init_ack: { success: true } } }) })));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const backend = {
    configured: true, account: { name: 'tester', remainingSeconds: 600 },
    async create(reference) {
      calls.push(['create', reference]);
      if (rejectCreate) throw new Error('剩余时长不足，无法开始新会话。');
      if (holdCreate) await new Promise(resolve => { release = resolve; });
      return { sessionId: 's-1', transport: { type: 'alirtc', token: 'rtc', userId: 'u', renderUid: 'render' }, control: control === 'vidu-ws' ? { type: 'vidu-ws', url: 'wss://control.example/connect', liveId: '100', connId: 'c-1', clientSecret: 'session-secret' } : { type: 'none' } };
    },
    async hangup(id) { calls.push(['hangup', id]); return ended ? { state: 'ended', billedSeconds: 2, creditsCost: 2 } : { state: 'unknown' }; },
    heartbeat(id) { calls.push(['heartbeat', id]); }
  };
  const session = new CloudSession({ backend, image, characterExists, Socket });
  return { session, calls, signals, backend, release: () => release() };
}

test('start returns only the transport; no provider key or control secret enters IPC state', async () => {
  const f = fixture(); const result = await f.session.start('qinghe');
  assert.deepEqual(Object.keys(result), ['transport']); assert.equal(result.transport.type, 'alirtc');
  assert.ok(!JSON.stringify(f.session.snapshot()).includes('session-secret'));
  assert.ok(f.session.socket.url.startsWith('wss://control.example/connect?'));
  assert.equal(f.session.snapshot().phase, 'waiting_frames');
  f.session.heartbeat({ frames: 8, width: 1280, height: 720 }); assert.equal(f.session.snapshot().phase, 'live');
  assert.ok(f.calls.some(call => call[0] === 'heartbeat'));
  await f.session.stop(); assert.equal(f.session.snapshot().billing, 'ended'); assert.equal(f.session.snapshot().billedSeconds, 2);
  assert.ok(f.signals.some(signal => signal.type === 5)); assert.ok(f.calls.some(call => call[0] === 'hangup'));
});
test('providers without a control socket skip it', async () => {
  const f = fixture({ control: 'none' }); await f.session.start('qinghe');
  assert.equal(f.session.socket, null); assert.equal(f.signals.length, 0);
  await f.session.stop(); assert.equal(f.session.snapshot().billing, 'ended');
});
test('cancel during creation hangs up the returned session without initializing', async () => {
  const f = fixture({ holdCreate: true }); const start = f.session.start('qinghe'); const stopped = f.session.stop();
  f.release(); await assert.rejects(start, /取消/); await stopped;
  assert.equal(f.signals.some(signal => signal.type === 1), false);
  assert.equal(f.calls.filter(call => call[0] === 'hangup').length, 1);
  assert.equal(f.session.snapshot().billing, 'ended');
});
test('unconfirmed hangup cannot be reported as ended or allow a second session', async () => {
  const f = fixture({ ended: false }); await f.session.start('qinghe'); await f.session.stop();
  assert.equal(f.session.snapshot().billing, 'unknown');
  await assert.rejects(f.session.start('qinghe'), /上一场/);
});
test('server refusals surface as visible errors without an active session', async () => {
  const f = fixture({ rejectCreate: true }); await assert.rejects(f.session.start('qinghe'), /剩余时长不足/);
  assert.equal(f.session.snapshot().phase, 'error'); assert.equal(f.session.snapshot().billing, 'none');
});
test('unknown characters, unreadable references, logged-out clients and duplicates never create sessions', async () => {
  const f = fixture(); await assert.rejects(f.session.start('nova'), /不可用/);
  const g = fixture({ image: () => { throw new Error('missing local image'); } }); await assert.rejects(g.session.start('qinghe'), /missing local image/);
  const h = fixture(); h.backend.configured = false; await assert.rejects(h.session.start('qinghe'), /登录/);
  await f.session.start('qinghe'); await assert.rejects(f.session.start('qinghe'), /上一场/); await f.session.stop();
  assert.equal(f.calls.filter(call => call[0] === 'create').length + g.calls.length + h.calls.length, 1);
});
test('privacy during initialization cancels promptly and confirms server hangup', async () => {
  const f = fixture({ holdInit: true }); const start = f.session.start('qinghe');
  await new Promise(resolve => setImmediate(resolve));
  const stopped = f.session.stop(); await assert.rejects(start, /取消/); await stopped;
  assert.equal(f.session.snapshot().billing, 'ended');
});
test('lost UI heartbeat still stops the session', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const f = fixture(); await f.session.start('qinghe');
  t.mock.timers.tick(12001); await f.session.stopping;
  assert.equal(f.session.snapshot().billing, 'ended'); assert.match(f.session.snapshot().error, /失去响应/);
});

test('end to end against the API contract: login, start, first frame reported, stop, billed from the first frame', async t => {
  let time = 5_000_000; const now = () => time;
  const server = await contractServer(t, { now });
  const backend = new ProxyBackend({ baseUrl: server.url, heartbeatEveryMs: 0 });
  const session = new CloudSession({ backend, image: () => 'data:image/jpeg;base64,AAAA', Socket: class { constructor() { throw new Error('no socket expected'); } } });
  assert.equal(session.snapshot().configured, false);
  await backend.login('dev', { name: 'e2e-user' });
  assert.deepEqual(session.snapshot().account, { name: 'e2e-user', remainingSeconds: 600 });
  const { transport } = await session.start('qinghe');
  assert.equal(transport.type, 'fake');
  time += 3_000; await backend.heartbeat('sess-1', 0);          // connecting: not billed
  time += 1_000; await backend.heartbeat('sess-1', 5);          // first frame
  time += 7_000;
  await session.stop();
  assert.equal(session.snapshot().billing, 'ended'); assert.equal(session.snapshot().billedSeconds, 7);
  await backend.refreshAccount(); assert.equal(backend.account.remainingSeconds, 593);
  await assert.rejects(backend.redeem('SF-BAD'), /兑换码无效/);
  const redeemed = await backend.redeem('SF-GOOD'); assert.equal(redeemed.credits, 99); assert.equal(backend.account.remainingSeconds, 593 + 99 * 60);
});

test('the server session is kept alive during a slow provider initialization', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const f = fixture({ holdInit: true }); f.backend.heartbeat = id => { f.calls.push(['heartbeat', id]); return Promise.resolve({ state: 'active' }); };
  const start = f.session.start('qinghe');
  for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(5000); }
  assert.ok(f.calls.filter(call => call[0] === 'heartbeat').length >= 4, 'keepalive before conn_init completes');
  const stopped = f.session.stop(); await assert.rejects(start, /取消/); await stopped;
  const count = f.calls.filter(call => call[0] === 'heartbeat').length; t.mock.timers.tick(20000);
  assert.equal(f.calls.filter(call => call[0] === 'heartbeat').length, count, 'keepalive stops after the end');
});

test('a server-side end (quota reached) stops the client with a clear reason', async () => {
  const f = fixture({ control: 'none' }); await f.session.start('qinghe');
  f.backend.heartbeat = () => Promise.resolve({ state: 'ended', endReason: 'quota_reached' });
  f.session.heartbeat({ frames: 1 }); await new Promise(resolve => setImmediate(resolve)); await f.session.stopping;
  assert.equal(f.session.snapshot().phase, 'ended'); assert.match(f.session.snapshot().error, /时长已用完/);
});

test('proxy backend shows our server\'s login messages and keeps the token out of the account object', async t => {
  const server = await contractServer(t, { now: Date.now });
  const backend = new ProxyBackend({ baseUrl: server.url });
  await assert.rejects(backend.requestCode('sms', { phone: '12' }), /11 位手机号/);
  await backend.requestCode('sms', { phone: '13800138000' });
  await assert.rejects(backend.login('sms', { phone: '13800138000', code: '123456' }), /验证码不正确/);
  const account = await backend.login('sms', { phone: '13800138000', code: '000000' });
  assert.equal(account.name, '138****8000'); assert.ok(!JSON.stringify(account).includes(backend.token));
  const restored = new ProxyBackend({ baseUrl: backend.baseUrl }); restored.restore(backend.token);
  assert.equal((await restored.refreshAccount()).name, '138****8000');
  restored.logout(); assert.equal(restored.configured, false);
});
