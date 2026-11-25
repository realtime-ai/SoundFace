const test = require('node:test');
const assert = require('node:assert/strict');
const { GeneratedOutputIntent } = require('../app/generated-output-intent.js');

test('one-click output waits for an actual frame and authoritative live state, then attaches only once', async () => {
  const calls = [];
  const intent = new GeneratedOutputIntent({ start: async () => { calls.push('start'); return { running: true }; }, stop: async () => calls.push('stop') });
  intent.request(); assert.equal(intent.active, true); assert.deepEqual(calls, []);
  const state = await intent.onFrame(async () => calls.push('live'));
  assert.equal(state.running, true); assert.deepEqual(calls, ['live', 'start']);
  await intent.onFrame(async () => calls.push('live'));
  assert.equal(intent.active, false); assert.deepEqual(calls, ['live', 'start']);
});

test('stopping during the live-state check cannot start a late producer', async () => {
  let ready, starts = 0;
  const intent = new GeneratedOutputIntent({ start: async () => { starts++; }, stop: async () => {} });
  intent.request();
  const work = intent.onFrame(() => new Promise(resolve => { ready = resolve; }));
  intent.cancel(); ready();
  assert.equal(await work, null); assert.equal(starts, 0); assert.equal(intent.active, false);
});

test('privacy or stop during native startup stops the late producer and cannot reattach on later frames', async () => {
  let finish, starts = 0, stops = 0;
  const intent = new GeneratedOutputIntent({ start: () => { starts++; return new Promise(resolve => { finish = resolve; }); }, stop: async () => { stops++; } });
  intent.request(); const work = intent.onFrame(async () => {});
  await Promise.resolve();
  assert.equal(intent.pending, true); intent.cancel(); finish({ running: true });
  assert.equal(await work, null); assert.equal(starts, 1); assert.equal(stops, 1);
  await intent.onFrame(async () => {}); assert.equal(starts, 1);
});
