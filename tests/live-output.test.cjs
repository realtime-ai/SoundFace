const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseLiveSource, LiveCompositor, LIVE_STALE_MS } = require('../app/live-output.js');
const { LocalTestSource } = require('../app/local-test-source.js');

const base = { privacy: false, testMode: false, testRunning: false, cloudPhase: 'live', cloudFrames: 10, lastFrameAt: 1000, now: 1000 };

test('fresh generated frames are shown; anything else falls back to a slate', () => {
  assert.equal(chooseLiveSource(base), 'cloud');
  assert.equal(chooseLiveSource({ ...base, now: 1000 + LIVE_STALE_MS }), 'cloud');
  assert.equal(chooseLiveSource({ ...base, now: 1001 + LIVE_STALE_MS }), 'placeholder', 'stale stream');
  assert.equal(chooseLiveSource({ ...base, cloudFrames: 0 }), 'placeholder', 'no first frame yet');
  for (const phase of ['idle', 'creating', 'connecting', 'waiting_frames', 'stopping', 'ended', 'error']) assert.equal(chooseLiveSource({ ...base, cloudPhase: phase }), 'placeholder', phase);
  assert.equal(chooseLiveSource({ ...base, lastFrameAt: undefined }), 'placeholder');
});

test('privacy always wins, and test mode never shows cloud video', () => {
  assert.equal(chooseLiveSource({ ...base, privacy: true }), 'privacy');
  assert.equal(chooseLiveSource({ ...base, privacy: true, testMode: true, testRunning: true }), 'privacy');
  assert.equal(chooseLiveSource({ ...base, testMode: true, testRunning: true }), 'test');
  assert.equal(chooseLiveSource({ ...base, testMode: true, testRunning: false }), 'placeholder');
});

function fakeCanvas() {
  const calls = [];
  const context = new Proxy({ calls }, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]), set: (target, key, value) => { calls.push(['set:' + String(key), value]); return true; } });
  return { canvas: { getContext: () => context }, calls };
}

test('compositor burns the AI label over generated video and only draws the given element', () => {
  const { canvas, calls } = fakeCanvas(); let time = 0;
  const compositor = new LiveCompositor(canvas, { now: () => time });
  assert.equal(canvas.width, 1280); assert.equal(canvas.height, 720);
  const video = { videoWidth: 952, videoHeight: 544 };
  assert.equal(compositor.render('cloud', video), 'cloud');
  const drawn = calls.filter(call => call[0] === 'drawImage');
  assert.equal(drawn.length, 1); assert.equal(drawn[0][1], video);
  assert.ok(calls.some(call => call[0] === 'fillText' && call[1] === 'AI GENERATED · SoundFace'));
});

test('compositor draws a slate, never an image, when the source is missing or not drawable', () => {
  for (const [source, element] of [['placeholder', null], ['privacy', null], ['cloud', { videoWidth: 0, videoHeight: 0 }], ['cloud', null]]) {
    const { canvas, calls } = fakeCanvas();
    const shown = new LiveCompositor(canvas).render(source, element);
    assert.notEqual(shown, 'cloud');
    assert.equal(calls.filter(call => call[0] === 'drawImage').length, 0, source);
    assert.ok(calls.some(call => call[0] === 'fillText' && call[1] === '稍后回来'));
  }
});

test('compositor reports measured frames per second', () => {
  const { canvas } = fakeCanvas(); let time = 0;
  const compositor = new LiveCompositor(canvas, { now: () => time });
  for (let index = 0; index <= 30; index++) { time = index * (1000 / 30); compositor.render('placeholder', null); }
  assert.equal(compositor.stats.fps, 31);
  assert.equal(compositor.stats.frames, 31);
});

test('local test source can run at 30 fps for the live window', () => {
  let period;
  const context = { fillRect() {}, fillText() {} };
  const source = new LocalTestSource({ getContext: () => context }, { fps: 30, schedule: (_tick, value) => { period = value; return 1; }, unschedule() {} });
  source.start(() => {}); source.stop();
  assert.equal(period, 34);
});
