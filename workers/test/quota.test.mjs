// Out-of-credit hang-up, with a tiny balance so the test does not wait minutes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, IMAGE, sleep } from './harness.mjs';

let w;
before(async () => { w = await startWorker({ TRIAL_SECONDS: '4', MIN_START_SECONDS: '1' }); }, { timeout: 60000 });
after(() => w?.stop());

test('a session is hung up when the balance runs out, billed exactly the balance, and a new one is refused', async () => {
  const { token, account } = await w.login('short@example.com');
  assert.equal(account.remainingSeconds, 4);
  const live = await w.ok('POST', '/v1/sessions', { image: IMAGE }, token);
  await w.ok('POST', `/v1/sessions/${live.sessionId}/heartbeat`, { frames: 1 }, token);
  let view;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    view = await w.ok('POST', `/v1/sessions/${live.sessionId}/heartbeat`, { frames: 30 * (i + 2) }, token); // client still alive
    if (view.state === 'ended') break;
  }
  assert.equal(view.state, 'ended'); assert.equal(view.endReason, 'quota_reached');
  assert.equal(view.billedSeconds, 4, 'never more than the balance');
  assert.equal((await w.ok('GET', '/v1/me', null, token)).remainingSeconds, 0);
  assert.equal((await w.call('POST', '/v1/sessions', { image: IMAGE }, token)).body.code, 'QUOTA_EXHAUSTED');
});
