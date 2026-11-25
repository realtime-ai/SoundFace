const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CaptureController } = require('../app/capture-controller.cjs');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fakeBridge() { const bridge = new EventEmitter(); bridge.calls = []; bridge.command = async (action, args) => { bridge.calls.push([action, args]); return { ok: true }; }; bridge.close = () => {}; return bridge; }
const flush = () => new Promise(resolve => setImmediate(resolve));

test('privacy cancels a delayed permission grant, even after leaving privacy mode', async () => {
  const grant = deferred(), bridge = fakeBridge();
  const controller = new CaptureController(bridge, () => grant.promise);
  const start = controller.start('physical'); const rejected = assert.rejects(start, /已取消/);
  await flush();
  const pause = controller.setPrivacy(true); await controller.setPrivacy(false);
  grant.resolve(true); await rejected; await pause;
  assert.equal(controller.state.running, false); assert.equal(controller.state.privacy, false);
  assert.ok(!bridge.calls.some(([action]) => action === 'start'));
});
test('privacy during native start always stops native capture before settling', async () => {
  const bridge = fakeBridge(), started = deferred();
  bridge.command = async action => { bridge.calls.push([action]); if (action === 'start') await started.promise; return { ok: true }; };
  const controller = new CaptureController(bridge, async () => true);
  const states = []; controller.on('state', state => states.push(state));
  const start = controller.start('physical'); const rejected = assert.rejects(start, /已进入隐私暂停/);
  await flush(); const pause = controller.setPrivacy(true); started.resolve();
  await rejected; await pause;
  assert.deepEqual(bridge.calls.map(([action]) => action), ['start', 'stop', 'stop']);
  assert.ok(states.every(state => !state.running));
});
test('cancelled pending start does not automatically resume', async () => {
  const bridge = fakeBridge(), controller = new CaptureController(bridge, async () => true);
  await controller.start('physical'); assert.equal(controller.state.running, true);
  await controller.setPrivacy(true); await controller.setPrivacy(false);
  assert.equal(controller.state.running, false);
  await controller.start('physical'); assert.equal(controller.state.running, true);
});
test('audio and camera controllers stop independently', async () => {
  const audioBridge = fakeBridge(), cameraBridge = fakeBridge();
  const audio = new CaptureController(audioBridge, async () => true), video = new CaptureController(cameraBridge, async () => true);
  await Promise.all([audio.start('mic'), video.start('camera')]);
  await audio.mute(true); await audio.stop();
  assert.equal(audio.state.running, false); assert.equal(video.state.running, true);
  assert.deepEqual(cameraBridge.calls.map(([action]) => action), ['start']);
});
test('native failure and stale frame events never display a running route', async () => {
  const bridge = fakeBridge(), controller = new CaptureController(bridge, async () => true);
  await controller.start('camera'); bridge.emit('frames', { submitted: 10, dropped: 1 });
  assert.equal(controller.state.submitted, 10);
  bridge.emit('stopped', 'unplugged'); bridge.emit('frames', { submitted: 100, dropped: 1 });
  assert.equal(controller.state.running, false); assert.equal(controller.state.submitted, 10);
  assert.equal(controller.state.error, 'unplugged');
});
test('permission denial never reaches the native start command', async () => {
  const bridge = fakeBridge(), controller = new CaptureController(bridge, async () => false);
  await assert.rejects(controller.start('physical'), /没有摄像头权限/);
  assert.equal(bridge.calls.length, 0); assert.equal(controller.state.running, false);
});
test('audio levels reflect native samples and stale levels are discarded after stop', async () => {
  const bridge = fakeBridge(), controller = new CaptureController(bridge, async () => true);
  await controller.start('mic');
  const levels = { inputPeak: 0.5, outputPeak: 0.4, sampleRate: 48000 };
  bridge.emit('levels', levels); assert.deepEqual(controller.state.levels, levels);
  await controller.mute(true);
  // A mute command alone is not evidence that the native callback output is silent.
  assert.equal(controller.state.levels.outputPeak, 0.4);
  bridge.emit('levels', { ...levels, outputPeak: 0 }); assert.equal(controller.state.levels.outputPeak, 0);
  await controller.stop(); bridge.emit('levels', levels); assert.equal(controller.state.levels, null);
});
