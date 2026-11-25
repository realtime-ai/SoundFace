'use strict';
(() => {
  const isOwnCamera = label => /soundface\s*camera/i.test(label || '');
  const list = devices => devices.filter(device => device.kind === 'videoinput' && !isOwnCamera(device.label));
  async function open(mediaDevices, preferred = '') {
    const inputs = list(await mediaDevices.enumerateDevices());
    const input = preferred ? inputs.find(device => device.deviceId === preferred) : inputs[0];
    if (!input) throw new Error(preferred ? '所选摄像头不可用，请重新选择。' : '未找到可用的输入摄像头。');
    // The system default can become our virtual camera after extension activation.
    // Always bind an explicit input and also check the returned track for races.
    const stream = await mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: input.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    const track = stream.getVideoTracks()[0];
    if (!track || isOwnCamera(track.label)) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('不能把 SoundFace Camera 作为自己的输入，请选择物理摄像头。');
    }
    return stream;
  }
  const api = { list, open };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.SoundFaceCameraInput = api;
})();
