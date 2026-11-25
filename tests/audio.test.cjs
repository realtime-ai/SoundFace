const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AudioBridge } = require('../app/audio.cjs');
const binary = path.resolve(__dirname, '../build/soundface-audio');

test('native enumeration returns real device structure and never starts capture', async () => {
  const bridge = new AudioBridge(binary);
  try {
    const value = await bridge.command('list');
    assert.ok(Array.isArray(value.inputs));
    assert.equal(typeof value.installed, 'boolean');
    assert.equal(typeof value.internalOutput, 'boolean');
    for (const device of value.inputs) { assert.equal(typeof device.uid, 'string'); assert.equal(typeof device.name, 'string'); }
  } finally { bridge.close(); }
});
test('self routing rejected, then engine remains usable', async () => {
  const bridge = new AudioBridge(binary);
  try {
    await assert.rejects(bridge.command('start', { uid: 'SoundFace_UID' }), /不能选 SoundFace Microphone/);
    assert.ok((await bridge.command('list')).inputs.length);
    assert.equal((await bridge.command('stop')).running, false);
  } finally { bridge.close(); }
});
test('unknown and missing devices fail without pretending to run', async () => {
  const bridge = new AudioBridge(binary);
  try {
    await assert.rejects(bridge.command('bad-command'), /未知命令/);
    await assert.rejects(bridge.command('start', { uid: 'soundface-test-nonexistent-input' }), /麦克风断开了/);
  } finally { bridge.close(); }
});
test('missing executable rejects pending commands and exposes stopped event', async () => {
  const bridge = new AudioBridge('/nonexistent/soundface-audio');
  let stopped = false; bridge.once('stopped', () => { stopped = true; });
  await assert.rejects(bridge.command('list'), /停了，请重新开启/); assert.ok(stopped);
});
