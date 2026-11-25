const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AudioBridge } = require('../app/audio.cjs');
const fs = require('node:fs');

test('video helper enumerates input and rejects output if the extension is missing', async t => {
  const bridge = new AudioBridge(path.resolve(__dirname, '../build/soundface-video'), '视频');
  try {
    const list = await bridge.command('list');
    assert.equal(typeof list.installed, 'boolean'); assert.ok(Array.isArray(list.inputs));
    if (!list.installed) await assert.rejects(bridge.command('start', { uid: list.inputs[0]?.uid || 'none' }), /尚未激活/);
    // Never start actual capture from an unattended unit test.
    assert.equal((await bridge.command('stop')).running, false);
    await assert.rejects(bridge.command('unknown'), /未知视频命令/);
  } finally { bridge.close(); }
});

test('real native probe converts a generated frame without a camera extension and rejects frames after stop', async () => {
  const bridge = new AudioBridge(path.resolve(__dirname, '../build/soundface-video'), '视频');
  try {
    let counts; bridge.on('frames', value => { counts = value; });
    await bridge.command('start', { uid: 'vidu-probe', liveID: 'offline-test' });
    const packet = { liveID: 'offline-test', jpeg: fs.readFileSync(path.resolve(__dirname, '../build/generated-frame-test.jpg')).toString('base64') };
    await bridge.command('frame', { ...packet, capturedAt: Date.now() });
    assert.equal(counts.converted, 1); assert.equal(counts.submitted, 0);
    await assert.rejects(bridge.command('frame', { ...packet, liveID: 'old-session', capturedAt: Date.now() }), /会话已切换/);
    await bridge.command('stop');
    assert.equal(counts.converted, 1); assert.equal(counts.submitted, 0);
    await assert.rejects(bridge.command('frame', { ...packet, capturedAt: Date.now() }), /已停止/);
  } finally { bridge.close(); }
});
