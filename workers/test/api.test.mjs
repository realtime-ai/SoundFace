// End-to-end tests against a real local `wrangler dev`. Fake provider only: no network, no cost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startWorker, IMAGE, sleep } from './harness.mjs';

let w; const call = (...a) => w.call(...a), ok = (...a) => w.ok(...a), d1 = sql => w.d1(sql), login = email => w.login(email);
before(async () => { w = await startWorker({ TRIAL_SECONDS: '120', HEARTBEAT_TIMEOUT_MS: '6000' }); }, { timeout: 60000 });
after(() => w?.stop());

test('email login: validation, resend limit, wrong code, trial credit, same account on re-login', async () => {
  assert.equal((await call('POST', '/v1/auth/email/code', { email: 'not-an-email' })).body.code, 'BAD_EMAIL');
  const sent = await ok('POST', '/v1/auth/email/code', { email: 'Anchor@Example.com' });
  assert.equal(sent.resendAfterSeconds, 60); assert.match(sent.devHint, /000000/);
  assert.equal((await call('POST', '/v1/auth/email/code', { email: 'anchor@example.com' })).status, 429);
  assert.equal((await call('POST', '/v1/auth/email/login', { email: 'anchor@example.com', code: '123456' })).body.code, 'CODE_WRONG');
  const { token, account } = await ok('POST', '/v1/auth/email/login', { email: 'ANCHOR@example.com', code: '000000' });
  assert.equal(account.id, 'email:anchor@example.com'); assert.equal(account.name, 'an***@example.com');
  assert.equal(account.remainingSeconds, 120); assert.equal(account.remainingMinutes, 2);
  assert.equal((await call('POST', '/v1/auth/email/login', { email: 'anchor@example.com', code: '000000' })).body.code, 'CODE_EXPIRED', 'codes are single use');
  assert.equal((await ok('GET', '/v1/me', null, token)).id, 'email:anchor@example.com');
  assert.equal((await call('GET', '/v1/me', null, 'bogus')).status, 401);
});

test('phone and email are separate accounts', async () => {
  await ok('POST', '/v1/auth/sms/code', { phone: '138 0013 8000' });
  const phone = await ok('POST', '/v1/auth/sms/login', { phone: '13800138000', code: '000000' });
  assert.equal(phone.account.id, 'phone:13800138000'); assert.equal(phone.account.name, '138****8000');
});

test('billing starts at the first frame; sessions without a frame cost nothing', async () => {
  const { token } = await login('bill@example.com');
  const noFrame = await ok('POST', '/v1/sessions', { image: IMAGE }, token);
  assert.equal(noFrame.provider, 'fake');
  assert.equal((await call('POST', '/v1/sessions', { image: IMAGE }, token)).body.code, 'SESSION_ACTIVE');
  await sleep(1500); await ok('POST', `/v1/sessions/${noFrame.sessionId}/heartbeat`, { frames: 0 }, token);
  const ended = await ok('POST', `/v1/sessions/${noFrame.sessionId}/hangup`, null, token);
  assert.equal(ended.state, 'ended'); assert.equal(ended.billedSeconds, 0);

  const live = await ok('POST', '/v1/sessions', { image: IMAGE }, token);
  await sleep(2000); await ok('POST', `/v1/sessions/${live.sessionId}/heartbeat`, { frames: 0 }, token); // connecting: free
  await ok('POST', `/v1/sessions/${live.sessionId}/heartbeat`, { frames: 3 }, token);                     // first frame
  await sleep(3200);
  const during = await ok('POST', `/v1/sessions/${live.sessionId}/heartbeat`, { frames: 90 }, token);
  assert.ok(during.remainingSeconds <= 117 && during.remainingSeconds >= 115, String(during.remainingSeconds));
  const done = await ok('POST', `/v1/sessions/${live.sessionId}/hangup`, null, token);
  assert.equal(done.billedSeconds, 3, 'only the seconds after the first frame are billed');
  const me = await ok('GET', '/v1/me', null, token);
  assert.equal(me.remainingSeconds, 117); assert.equal(me.remainingMinutes, 1, 'partial minutes are not rounded up');
  const history = await ok('GET', '/v1/history', null, token);
  assert.deepEqual(history.sessions.map(item => item.seconds), [3, 0]);
  assert.equal(history.purchases[0].source, 'trial');
});

test('a client that stops heartbeating is hung up by the alarm and billed only up to its last heartbeat', async () => {
  const { token } = await login('lost@example.com');
  const live = await ok('POST', '/v1/sessions', { image: IMAGE }, token);
  await ok('POST', `/v1/sessions/${live.sessionId}/heartbeat`, { frames: 1 }, token);
  let view;
  for (let i = 0; i < 30; i++) { await sleep(1000); view = await ok('GET', `/v1/sessions/${live.sessionId}`, null, token); if (view.state === 'ended') break; }
  assert.equal(view.state, 'ended'); assert.equal(view.endReason, 'client_lost');
  assert.ok(view.billedSeconds <= 1, String(view.billedSeconds));
});

test('redeem codes: credit once, reject reuse, lock after 5 failures', async () => {
  const { token } = await login('pay@example.com');
  const code = 'K3T0J4H1T97KV59Z';
  d1(`INSERT INTO redeem_codes (code_hash, hint, credits, batch, note, created_at) VALUES ('${createHash('sha256').update(code).digest('hex')}', '9Z', 99, 'test', '', ${Date.now()})`);
  const redeemed = await ok('POST', '/v1/redeem', { code: 'sf-k3t0-j4h1-t97k-v59z' }, token);
  assert.equal(redeemed.credits, 99); assert.equal(redeemed.account.remainingSeconds, 120 + 99 * 60);
  const other = await login('other@example.com');
  assert.equal((await call('POST', '/v1/redeem', { code }, other.token)).body.code, 'REDEEM_INVALID', 'one-time');
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/v1/redeem', { code: 'SF-AAAA-BBBB-CCCC-DDDD' }, other.token)).body.code, 'REDEEM_INVALID');
  assert.match((await call('POST', '/v1/redeem', { code: 'SF-AAAA-BBBB-CCCC-DDDE' }, other.token)).body.message, /15 分钟/);
  assert.equal((await call('POST', '/v1/redeem', { code: 'whatever' }, other.token)).body.code, 'REDEEM_LOCKED');
  const history = await ok('GET', '/v1/history', null, token);
  assert.equal(history.purchases.find(item => item.source === 'redeem').credits, 99);
  assert.equal((await ok('GET', '/v1/plans')).plans[0].priceYuan, 99);
});

