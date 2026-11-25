const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonStore } = require('../server/store.cjs');
const { SessionService, HEARTBEAT_TIMEOUT_MS } = require('../server/service.cjs');
const { createServer } = require('../server/http.cjs');
const { DevAuthenticator } = require('../server/auth.cjs');
const { FakeProvider } = require('../server/providers/fake.cjs');
const { ViduProvider } = require('../server/providers/vidu.cjs');
const { provider: chooseProvider } = require('../server/index.cjs');

const IMAGE = 'data:image/jpeg;base64,AAAA';
function fixture(options = {}) {
  let time = 1_000_000;
  const clock = { now: () => time, advance: ms => { time += ms; } };
  const provider = new FakeProvider({ now: clock.now, ...options.provider });
  const store = new JsonStore(null);
  const service = new SessionService({ store, provider, authenticators: [new DevAuthenticator()], now: clock.now, defaultQuotaSeconds: options.quota ?? 600, pollDelay: 0, pollAttempts: 3 });
  return { clock, provider, store, service };
}

test('dev login creates an account with the default quota and a bearer token', async () => {
  const f = fixture(); const { token, account } = await f.service.login('dev', { name: 'tester' });
  assert.ok(token.length >= 40); assert.equal(account.remainingSeconds, 600);
  assert.equal(f.service.authenticate(token).id, 'dev:tester');
  assert.throws(() => f.service.authenticate('nope'), /登录/);
  await assert.rejects(f.service.login('sms', {}), /不可用/);
});

test('billed seconds are deducted exactly once after the provider confirms the end', async () => {
  const f = fixture(); const { token } = await f.service.login('dev', { name: 'user-a' }); const user = f.service.authenticate(token);
  const created = await f.service.createSession(user, { image: IMAGE });
  assert.equal(created.transport.type, 'fake'); assert.equal(created.provider, 'fake');
  assert.equal(created.secret, undefined, 'no server-only fields leak');
  f.clock.advance(42_300);
  const ended = await f.service.hangup(user, created.sessionId);
  assert.equal(ended.state, 'ended'); assert.equal(ended.billedSeconds, 43);
  await f.service.hangup(user, created.sessionId); await f.service.reap();
  assert.equal(f.service.account(user).usedSeconds, 43);
  assert.equal(f.service.account(user).remainingSeconds, 557);
});

test('a second session is refused until the first is confirmed ended', async () => {
  const f = fixture(); const { token } = await f.service.login('dev', { name: 'user-a' }); const user = f.service.authenticate(token);
  const first = await f.service.createSession(user, { image: IMAGE });
  await assert.rejects(f.service.createSession(user, { image: IMAGE }), /尚未结束/);
  await f.service.hangup(user, first.sessionId);
  await f.service.createSession(user, { image: IMAGE });
});

test('unconfirmed hangup stays unknown, blocks new sessions, and the reaper settles it later', async () => {
  const f = fixture(); const { token } = await f.service.login('dev', { name: 'user-a' }); const user = f.service.authenticate(token);
  const created = await f.service.createSession(user, { image: IMAGE });
  f.provider.neverEnds = true; f.clock.advance(5000);
  assert.equal((await f.service.hangup(user, created.sessionId)).state, 'unknown');
  assert.equal(f.service.account(user).usedSeconds, 0);
  await assert.rejects(f.service.createSession(user, { image: IMAGE }), /尚未结束/);
  f.provider.neverEnds = false; await f.service.reap();
  assert.equal(f.service.view(created.sessionId).state, 'ended');
  assert.equal(f.service.account(user).usedSeconds, 5);
});

test('quota: refuse to start with < 60 s left; reaper hangs up when the quota is reached', async () => {
  const f = fixture({ quota: 100 }); const { token } = await f.service.login('dev', { name: 'user-a' }); const user = f.service.authenticate(token);
  const created = await f.service.createSession(user, { image: IMAGE });
  f.clock.advance(50_000); f.service.heartbeat(user, created.sessionId); await f.service.reap();
  assert.equal(f.service.view(created.sessionId).state, 'active');
  f.clock.advance(50_000); f.service.heartbeat(user, created.sessionId); await f.service.reap();
  const view = f.service.view(created.sessionId);
  assert.equal(view.state, 'ended'); assert.equal(view.endReason, 'quota_reached');
  assert.equal(f.service.account(user).remainingSeconds, 0);
  await assert.rejects(f.service.createSession(user, { image: IMAGE }), /剩余时长不足/);
});

test('reaper hangs up sessions whose client stopped heartbeating', async () => {
  const f = fixture(); const { token } = await f.service.login('dev', { name: 'user-a' }); const user = f.service.authenticate(token);
  const created = await f.service.createSession(user, { image: IMAGE });
  f.clock.advance(HEARTBEAT_TIMEOUT_MS - 1000); await f.service.reap();
  assert.equal(f.service.view(created.sessionId).state, 'active');
  f.clock.advance(2000); await f.service.reap();
  assert.equal(f.service.view(created.sessionId).endReason, 'client_lost');
  assert.equal(f.service.view(created.sessionId).state, 'ended');
});

test('users cannot see or end each other\'s sessions', async () => {
  const f = fixture();
  const a = f.service.authenticate((await f.service.login('dev', { name: 'user-a' })).token);
  const b = f.service.authenticate((await f.service.login('dev', { name: 'user-b' })).token);
  const created = await f.service.createSession(a, { image: IMAGE });
  assert.throws(() => f.service.heartbeat(b, created.sessionId), /不存在/);
  await assert.rejects(f.service.hangup(b, created.sessionId), /不存在/);
});

test('failed upstream creation does not leave an active session or charge', async () => {
  const f = fixture({ provider: { failCreate: true } }); const user = f.service.authenticate((await f.service.login('dev', { name: 'user-a' })).token);
  await assert.rejects(f.service.createSession(user, { image: IMAGE }), /暂时不可用/);
  assert.equal(f.service.account(user).activeSession, null); assert.equal(f.service.account(user).usedSeconds, 0);
});

test('HTTP API: login, me, create, heartbeat, hangup; unauthenticated requests are rejected', async t => {
  const f = fixture(); const server = createServer(f.service);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, token) => { const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await call('GET', '/v1/me')).status, 401);
  assert.equal((await call('POST', '/v1/auth/sms/login', {})).status, 404);
  const { body: login } = await call('POST', '/v1/auth/dev/login', { name: 'http-user' });
  assert.equal((await call('GET', '/v1/me', null, login.token)).body.remainingSeconds, 600);
  assert.equal((await call('POST', '/v1/sessions', { image: 'http://example.com/x.jpg' }, login.token)).status, 400);
  const { body: created } = await call('POST', '/v1/sessions', { image: IMAGE }, login.token);
  assert.equal(created.transport.type, 'fake');
  assert.equal((await call('POST', `/v1/sessions/${created.sessionId}/heartbeat`, {}, login.token)).body.state, 'active');
  f.clock.advance(3000);
  assert.equal((await call('POST', `/v1/sessions/${created.sessionId}/hangup`, {}, login.token)).body.billedSeconds, 3);
  assert.equal((await call('GET', '/v1/me', null, login.token)).body.usedSeconds, 3);
});

test('paid provider needs an explicit opt-in and never sends the key to clients', async () => {
  assert.equal(chooseProvider({}).name, 'fake');
  assert.throws(() => chooseProvider({ SOUNDFACE_PROVIDER: 'vidu', VIDU_API_KEY: 'vda_' + 'x'.repeat(24) }), /ALLOW_PAID/);
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ live: { id: 7 }, rtc: { token: 'rtc-token', user_id: 'u1' }, render_uid: 99, client_secret: 'sess-secret' }) }; };
  const key = 'vda_' + 'k'.repeat(24);
  const vidu = new ViduProvider({ key, fetchImpl, Socket: null });
  const created = await vidu.create({ image: IMAGE });
  assert.equal(requests[0].options.headers.Authorization, key);
  assert.equal(JSON.parse(requests[0].options.body).editing_type, 'subject_replacement');
  assert.deepEqual(created.transport, { type: 'alirtc', token: 'rtc-token', userId: 'u1', renderUid: '99' });
  assert.equal(created.control.type, 'vidu-ws'); assert.equal(created.control.connId, created.connId);
  assert.ok(!JSON.stringify({ transport: created.transport, control: created.control }).includes(key));
});

test('an orphaned creating record is released so the account is not stuck', async () => {
  const { CREATE_TIMEOUT_MS } = require('../server/service.cjs');
  const f = fixture(); const user = f.service.authenticate((await f.service.login('dev', { name: 'user-c' })).token);
  f.store.putSession({ id: 'orphan', userId: user.id, provider: 'fake', state: 'creating', createdAt: f.clock.now(), lastSeenAt: f.clock.now(), liveId: null, settled: false });
  await assert.rejects(f.service.createSession(user, { image: IMAGE }), /尚未结束/);
  f.clock.advance(CREATE_TIMEOUT_MS + 1); await f.service.reap();
  assert.equal(f.store.session('orphan').state, 'failed');
  await f.service.createSession(user, { image: IMAGE });
});

test('SMS login: code request, resend limit, wrong code, attempt lock, masked account name', async () => {
  const { SmsAuthenticator, DevSmsSender } = require('../server/auth.cjs');
  let time = 0; const sms = new SmsAuthenticator({ sender: new DevSmsSender(), now: () => time });
  const service = new SessionService({ store: new JsonStore(null), provider: new FakeProvider(), authenticators: [sms], now: () => time });
  await assert.rejects(service.requestCode('sms', { phone: '123' }), /11 位手机号/);
  const sent = await service.requestCode('sms', { phone: '138 0013 8000' });
  assert.equal(sent.resendAfterSeconds, 60); assert.match(sent.devHint, /000000/);
  await assert.rejects(service.requestCode('sms', { phone: '13800138000' }), /太频繁/);
  await assert.rejects(service.login('sms', { phone: '13800138000', code: '111111' }), /不正确/);
  const { account } = await service.login('sms', { phone: '13800138000', code: '000000' });
  assert.equal(account.name, '138****8000'); assert.equal(account.id, 'phone:13800138000');
  await assert.rejects(service.login('sms', { phone: '13800138000', code: '000000' }), /过期/, 'codes are single-use');
  time += 61_000; await service.requestCode('sms', { phone: '13800138000' });
  for (let i = 0; i < 5; i++) await assert.rejects(service.login('sms', { phone: '13800138000', code: '999999' }), /不正确/);
  await assert.rejects(service.login('sms', { phone: '13800138000', code: '000000' }), /次数过多/);
  time += 6 * 60_000; await service.requestCode('sms', { phone: '13900139000' }); time += 5 * 60_000 + 1;
  await assert.rejects(service.login('sms', { phone: '13900139000', code: '000000' }), /过期/);
});

test('email login: format check, resend limit, wrong code, single use, lowercase account, separate from phone', async () => {
  const { EmailAuthenticator, DevEmailSender, SmsAuthenticator, DevSmsSender } = require('../server/auth.cjs');
  let time = 0;
  const service = new SessionService({ store: new JsonStore(null), provider: new FakeProvider(), now: () => time,
    authenticators: [new EmailAuthenticator({ sender: new DevEmailSender(), now: () => time }), new SmsAuthenticator({ sender: new DevSmsSender(), now: () => time })] });
  for (const bad of ['', 'abc', 'a@b', 'a b@x.com', '@x.com', 'x@.com', 'a@x.c']) await assert.rejects(service.requestCode('email', { email: bad }), /正确的邮箱/, bad);
  const sent = await service.requestCode('email', { email: ' Host@Example.COM ' });
  assert.equal(sent.resendAfterSeconds, 60); assert.match(sent.devHint, /000000/);
  await assert.rejects(service.requestCode('email', { email: 'host@example.com' }), /太频繁/);
  await assert.rejects(service.login('email', { email: 'host@example.com', code: '123456' }), /不正确/);
  const { account, token } = await service.login('email', { email: 'HOST@example.com', code: '000000' });
  assert.equal(account.id, 'email:host@example.com'); assert.equal(account.name, 'ho***@example.com'); assert.equal(account.remainingSeconds, 600);
  await assert.rejects(service.login('email', { email: 'host@example.com', code: '000000' }), /过期/, 'codes are single-use');
  time += 61_000; await service.requestCode('email', { email: 'host@example.com' });
  const again = await service.login('email', { email: 'host@example.com', code: '000000' });
  assert.equal(service.authenticate(again.token).id, service.authenticate(token).id, 'same email returns the same account');
  await service.requestCode('sms', { phone: '13800138000' });
  const phone = await service.login('sms', { phone: '13800138000', code: '000000' });
  assert.notEqual(phone.account.id, account.id, 'phone and email are separate accounts for now');
});

test('without the development flag no login method (and no fixed SMS code) is registered', async () => {
  const service = new SessionService({ store: new JsonStore(null), provider: new FakeProvider(), authenticators: [] });
  await assert.rejects(service.requestCode('sms', { phone: '13800138000' }), /不可用/);
  await assert.rejects(service.requestCode('email', { email: 'a@example.com' }), /不可用/);
  await assert.rejects(service.login('dev', { name: 'someone' }), /不可用/);
});
