'use strict';
(() => {
  const isOwnCamera = label => /soundface\s*camera/i.test(label || '');
  const list = devices => devices.filter(device => device.kind === 'videoinput' && !isOwnCamera(device.label));
  async function open(mediaDevices, preferred = '') {
    const inputs = list(await mediaDevices.enumerateDevices());
    const input = preferred ? inputs.find(device => device.deviceId === preferred) : inputs[0];
    if (!input) throw new Error(preferred ? '所选摄像头不可用，请重新选择。' : '没有找到摄像头，请检查是否接好。');
    // The system default can become our virtual camera after extension activation.
    // Always bind an explicit input and also check the returned track for races.
    const stream = await mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: input.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    const track = stream.getVideoTracks()[0];
    if (!track || isOwnCamera(track.label)) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('这里要选电脑上的真实摄像头，不能选 SoundFace Camera。');
    }
    return stream;
  }
  const api = { list, open };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.SoundFaceCameraInput = api;
})();
