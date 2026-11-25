const test = require('node:test');
const assert = require('node:assert/strict');
const camera = require('../app/camera-input.js');
const devices = [
  { kind: 'videoinput', label: 'SoundFace Camera', deviceId: 'virtual' },
  { kind: 'audioinput', label: 'Microphone', deviceId: 'mic' },
  { kind: 'videoinput', label: 'FaceTime HD Camera', deviceId: 'physical' }
];
test('virtual camera becoming first/default never makes the preview capture itself', async () => {
  let requested;
  const stream = { getVideoTracks: () => [{ label: 'FaceTime HD Camera' }] };
  const actual = await camera.open({ enumerateDevices: async () => devices, getUserMedia: async options => { requested = options; return stream; } });
  assert.equal(actual, stream);
  assert.equal(requested.audio, false);
  assert.deepEqual(requested.video.deviceId, { exact: 'physical' });
});
test('missing or explicitly selected virtual input does not silently change the camera', async () => {
  const media = { enumerateDevices: async () => devices, getUserMedia: async () => { throw new Error('must not capture'); } };
  await assert.rejects(camera.open(media, 'virtual'), /重新选择/);
  await assert.rejects(camera.open(media, 'unplugged'), /重新选择/);
});
test('a returned virtual track is closed even when enumeration claimed a physical input', async () => {
  let stops = 0;
  const track = { label: 'SoundFace Camera', stop: () => stops++ };
  const media = { enumerateDevices: async () => devices, getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) };
  await assert.rejects(camera.open(media), /不能把 SoundFace Camera/);
  assert.equal(stops, 1);
});
