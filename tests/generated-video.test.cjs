const test = require('node:test');
const assert = require('node:assert/strict');
const { GeneratedVideoRelay } = require('../app/generated-video.cjs');
const { RemoteFramePump } = require('../app/remote-frame-pump.js');
const jpeg = new Uint8Array([255, 216, 255, 217]);

test('frame relay bounds in-flight work, rejects old routes and never forwards while stopped', async () => {
  let finish, calls = 0, allowed = true;
  const relay = new GeneratedVideoRelay({ command: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }, () => allowed, () => 1000);
  const firstToken = relay.arm('live-1');
  const packet = { liveID: 'live-1', frameToken: firstToken, capturedAt: 990, bytes: jpeg };
  const pending = relay.frame(packet);
  assert.equal((await relay.frame(packet)).forwarded, false); assert.equal(calls, 1);
  relay.disarm(); finish({}); await pending;
  assert.equal((await relay.frame(packet)).forwarded, false);
  const nextToken = relay.arm('live-1'); assert.notEqual(nextToken, firstToken);
  assert.equal((await relay.frame(packet)).forwarded, false);
  allowed = false;
  assert.equal((await relay.frame({ ...packet, frameToken: nextToken })).forwarded, false);
  assert.equal(calls, 1);
});

test('frame relay rejects expired, future, oversized and malformed payloads', async () => {
  let calls = 0;
  const relay = new GeneratedVideoRelay({ command: async () => { calls++; } }, () => true, () => 1000);
  const packet = { liveID: 'live', frameToken: relay.arm('live'), capturedAt: 1000, bytes: jpeg };
  for (const capturedAt of [749, 1051, NaN]) assert.equal((await relay.frame({ ...packet, capturedAt })).forwarded, false);
  for (const bytes of [new Uint8Array(524289), 'data', new Uint8Array([0, 0, 0, 0])]) await assert.rejects(relay.frame({ ...packet, bytes }), /格式无效/);
  assert.equal(calls, 0);
  assert.equal((await relay.frame(packet)).forwarded, true); assert.equal(calls, 1);
});

function pumpSetup() {
  let route = { liveID: 'live', frameToken: 'token' }, encode, sent = [], draws = [], failures = [], time = 1000;
  const ctx = { fillRect() {}, fillText(text) { draws.push(text); }, drawImage(source) { draws.push(source); } };
  const canvas = { getContext: () => ctx, toBlob: callback => { encode = callback; } };
  const pump = new RemoteFramePump({ route: () => route, canvas, now: () => time, clock: () => time,
    send: async packet => { sent.push(packet); return { forwarded: true }; }, fail: async error => failures.push(error) });
  const element = { videoWidth: 952, videoHeight: 544 };
  const blob = { size: jpeg.length, arrayBuffer: async () => jpeg.buffer };
  return { pump, element, sent, draws, failures, finish: () => encode(blob), setRoute: value => { route = value; }, setTime: value => { time = value; } };
}
test('frame pump reads only the supplied remote video and burns an AI label into the frame', async () => {
  const f = pumpSetup(); const work = f.pump.offer(f.element);
  await f.pump.offer(f.element); assert.equal(f.pump.stats.skipped, 1);
  f.finish(); await work;
  assert.equal(f.sent.length, 1); assert.equal(f.draws[0], f.element);
  assert.match(f.draws[1], /AI 合成/); assert.equal(f.sent[0].frameToken, 'token');
  assert.equal(f.pump.stats.forwarded, 1);
});
test('local canvas simulation uses the same frame transport with an explicit test label', async () => {
  const f = pumpSetup(); f.setRoute({ liveID: 'local-test', frameToken: 'token', kind: 'test' });
  const canvas = { width: 1280, height: 720 };
  const work = f.pump.offer(canvas); f.finish(); await work;
  assert.equal(f.sent.length, 1); assert.equal(f.draws[0], canvas);
  assert.match(f.draws[1], /测试画面/); assert.ok(!f.draws[1].includes('AI 合成'));
  assert.equal(f.sent[0].liveID, 'local-test'); assert.equal(f.sent[0].kind, 'test');
});
test('stop, stream replacement and stale asynchronous encodes cannot leak a frame', async () => {
  for (const cancel of [f => f.pump.reset(), f => f.setRoute(null), f => f.setRoute({ frameToken: 'new' }), f => f.setTime(1251)]) {
    const f = pumpSetup(); const work = f.pump.offer(f.element); cancel(f); f.finish(); await work;
    assert.equal(f.sent.length, 0); assert.equal(f.pump.busy, false);
  }
});
