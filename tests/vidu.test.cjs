const test = require('node:test');
const assert = require('node:assert/strict');
const { ViduSession } = require('../app/vidu.cjs');

function fixture({ holdCreate = false, holdInit = false, ended = true, rejectCreate = false, image = () => 'data:image/jpeg;base64,reference', characterExists } = {}) {
  const requests = [], signals = []; let release;
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(text) {
      const data = JSON.parse(text); signals.push(data);
      if (data.type === 1 && !holdInit) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 2, payload: { conn_init_ack: { success: true } } }) })));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') {
      if (rejectCreate) return { ok: false, status: 401, json: async () => ({ reason: 'UNAUTHORIZED', message: 'do not expose raw server text' }) };
      if (holdCreate) await new Promise(resolve => { release = resolve; });
      return { ok: true, json: async () => ({ live: { id: '100' }, rtc: { token: 'short-lived-token', user_id: 'user' }, client_secret: 'short-lived-secret', render_uid: 'render' }) };
    }
    return { ok: true, json: async () => ({ live: { status: ended ? 'ended' : 'on_live', billed_seconds: 2, credits_cost: 2 } }) };
  };
  const session = new ViduSession({ key: 'test-key-main-only', image, characterExists, Socket, fetchImpl, pollDelay: 0 });
  return { session, requests, signals, release: () => release() };
}

test('real editing type is explicit; permanent key is absent from IPC state and RTC result', async () => {
  const f = fixture(); const credentials = await f.session.start('qinghe');
  assert.equal(JSON.parse(f.requests[0].options.body).editing_type, 'subject_replacement');
  assert.equal(f.requests[0].options.headers.Authorization, 'test-key-main-only');
  assert.ok(!f.session.socket.url.includes('test-key-main-only'));
  assert.ok(!JSON.stringify([credentials, f.session.snapshot()]).includes('test-key-main-only'));
  assert.equal(f.session.snapshot().phase, 'waiting_frames');
  f.session.heartbeat({ frames: 8, width: 1280, height: 720 }); assert.equal(f.session.snapshot().phase, 'live');
  await f.session.stop(); assert.equal(f.session.snapshot().billing, 'ended'); assert.equal(f.session.snapshot().billedSeconds, 2);
  assert.ok(f.signals.some(signal => signal.type === 5));
});
test('cancel during REST creation hangs up the returned session without initializing billing', async () => {
  const f = fixture({ holdCreate: true }); const start = f.session.start('qinghe'); const stopped = f.session.stop();
  f.release(); await assert.rejects(start, /取消/); await stopped;
  assert.equal(f.signals.some(signal => signal.type === 1), false);
  assert.equal(f.signals.filter(signal => signal.type === 5).length, 1);
  assert.equal(f.session.snapshot().billing, 'ended');
});
test('unconfirmed hangup cannot be reported as ended or allow a second billable session', async () => {
  const f = fixture({ ended: false }); await f.session.start('qinghe'); await f.session.stop();
  assert.equal(f.session.snapshot().billing, 'unknown');
  await assert.rejects(f.session.start('qinghe'), /上一场/);
});
test('placeholder and duplicate starts cannot create paid sessions', async () => {
  const f = fixture(); await assert.rejects(f.session.start('nova'), /不可用/); assert.equal(f.requests.length, 0);
  await f.session.start('qinghe'); await assert.rejects(f.session.start('qinghe'), /上一场/); await f.session.stop();
});
test('unauthorized API response remains a visible error without an active session', async () => {
  const f = fixture({ rejectCreate: true }); await assert.rejects(f.session.start('qinghe'), /401/);
  assert.equal(f.session.snapshot().phase, 'error'); assert.equal(f.session.snapshot().billing, 'none');
  assert.ok(!f.session.snapshot().error.includes('do not expose'));
});
test('privacy during initialization cancels promptly and confirms server hangup', async () => {
  const f = fixture({ holdInit: true }); const start = f.session.start('qinghe');
  await new Promise(resolve => setImmediate(resolve));
  const stopped = f.session.stop(); await assert.rejects(start, /取消/); await stopped;
  assert.equal(f.session.snapshot().billing, 'ended');
  assert.ok(f.signals.some(signal => signal.type === 5));
});
test('healthy sessions continue beyond 60 seconds until the user explicitly stops', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const f = fixture(); await f.session.start('qinghe');
  for (let seconds = 1; seconds <= 90; seconds++) {
    f.session.heartbeat({ frames: seconds * 20, width: 952, height: 544 });
    t.mock.timers.tick(1000);
  }
  assert.equal(f.session.snapshot().phase, 'live');
  assert.equal(f.session.snapshot().billing, 'active');
  assert.equal(f.signals.some(signal => signal.type === 5), false);
  await f.session.stop();
  assert.equal(f.session.snapshot().billing, 'ended');
  assert.ok(f.signals.some(signal => signal.type === 5));
});
test('removing the duration cap retains the lost-heartbeat shutdown', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const f = fixture(); await f.session.start('qinghe');
  t.mock.timers.tick(12001);
  await f.session.stopping;
  assert.equal(f.session.snapshot().billing, 'ended');
  assert.match(f.session.snapshot().error, /失去响应/);
});
test('a saved custom character supplies its own reference without exposing it in session state', async () => {
  const id = 'custom-00000000-0000-0000-0000-000000000001';
  const f = fixture({ characterExists: candidate => candidate === id, image: candidate => { assert.equal(candidate, id); return 'data:image/jpeg;base64,custom-reference'; } });
  await f.session.start(id);
  assert.equal(JSON.parse(f.requests[0].options.body).image_url, 'data:image/jpeg;base64,custom-reference');
  assert.equal(f.session.snapshot().characterId, id);
  assert.ok(!JSON.stringify(f.session.snapshot()).includes('custom-reference'));
  await f.session.stop();
});
test('an unreadable character reference never creates a paid remote session', async () => {
  const f = fixture({ image: () => { throw new Error('missing local image'); } });
  await assert.rejects(f.session.start('qinghe'), /missing local image/);
  assert.equal(f.requests.length, 0); assert.equal(f.session.snapshot().billing, 'none');
});
