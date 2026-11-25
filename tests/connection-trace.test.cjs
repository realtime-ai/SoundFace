const test = require('node:test');
const assert = require('node:assert/strict');
const { ConnectionTrace } = require('../app/connection-trace.cjs');

test('connection diagnosis records ordered publish/subscription progress and keeps attempts separate', () => {
  let time = 100;
  const trace = new ConnectionTrace(() => time++);
  trace.record({ stage: 'attempt-start', code: 'auto' });
  trace.record({ stage: 'rtc-joined', code: 'ok' });
  trace.record({ stage: 'video-publish', code: '0-1' });
  assert.equal(trace.record({ stage: 'video-publish', code: '0-1' }), false);
  assert.deepEqual(trace.snapshot().map(event => event.stage), ['attempt-start', 'rtc-joined', 'video-publish']);
  const copy = trace.snapshot(); copy[0].code = 'tampered'; assert.equal(trace.snapshot()[0].code, 'auto');
  trace.record({ stage: 'attempt-start', code: 'tcp' });
  assert.deepEqual(trace.snapshot(), [{ at: 103, stage: 'attempt-start', code: 'tcp' }]);
});

test('connection diagnosis never accepts raw SDK objects, URLs, credentials or unbounded history', () => {
  const trace = new ConnectionTrace();
  for (const code of ['https://example.test/?auth_key=secret', 'vda_' + 'x'.repeat(24), { token: 'secret' }, 'x'.repeat(10000)]) {
    assert.equal(trace.record({ stage: 'start-error', code }), false);
  }
  assert.equal(trace.record({ stage: 'raw-sdk-object', code: 'ok' }), false);
  for (let index = 0; index < 100; index++) trace.record({ stage: 'video-publish', code: '1-' + index });
  assert.equal(trace.snapshot().length, 32);
  assert.ok(!JSON.stringify(trace.snapshot()).includes('secret'));
});
