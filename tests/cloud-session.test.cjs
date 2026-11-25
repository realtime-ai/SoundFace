const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudSession } = require('../app/cloud-session.cjs');
const { ProxyBackend } = require('../app/cloud-backend.cjs');
const { JsonStore } = require('../server/store.cjs');
const { SessionService } = require('../server/service.cjs');
const { createServer } = require('../server/http.cjs');
const { DevAuthenticator } = require('../server/auth.cjs');
const { FakeProvider } = require('../server/providers/fake.cjs');

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

test('end to end against the local server with the fake provider: login, start, stop, quota deducted', async t => {
  let time = 5_000_000; const now = () => time;
  const service = new SessionService({ store: new JsonStore(null), provider: new FakeProvider({ now }), authenticators: [new DevAuthenticator()], now, pollDelay: 0, pollAttempts: 2 });
  const server = createServer(service); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const backend = new ProxyBackend({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  const session = new CloudSession({ backend, image: () => 'data:image/jpeg;base64,AAAA', Socket: class { constructor() { throw new Error('no socket expected'); } } });
  assert.equal(session.snapshot().configured, false);
  await backend.login('dev', { name: 'e2e-user' });
  assert.deepEqual(session.snapshot().account, { name: 'e2e-user', remainingSeconds: 600 });
  const { transport } = await session.start('qinghe');
  assert.equal(transport.type, 'fake');
  time += 7_200;
  await session.stop();
  assert.equal(session.snapshot().billing, 'ended'); assert.equal(session.snapshot().billedSeconds, 8);
  await backend.refreshAccount(); assert.equal(backend.account.remainingSeconds, 592);
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
  const { SmsAuthenticator, DevSmsSender } = require('../server/auth.cjs');
  const service = new SessionService({ store: new JsonStore(null), provider: new FakeProvider(), authenticators: [new SmsAuthenticator({ sender: new DevSmsSender() })], pollDelay: 0 });
  const server = createServer(service); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const backend = new ProxyBackend({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(backend.requestCode('sms', { phone: '12' }), /11 位手机号/);
  await backend.requestCode('sms', { phone: '13800138000' });
  await assert.rejects(backend.login('sms', { phone: '13800138000', code: '123456' }), /验证码不正确/);
  const account = await backend.login('sms', { phone: '13800138000', code: '000000' });
  assert.equal(account.name, '138****8000'); assert.ok(!JSON.stringify(account).includes(backend.token));
  const restored = new ProxyBackend({ baseUrl: backend.baseUrl }); restored.restore(backend.token);
  assert.equal((await restored.refreshAccount()).name, '138****8000');
  restored.logout(); assert.equal(restored.configured, false);
});
