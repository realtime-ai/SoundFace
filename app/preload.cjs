const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('soundface', {
  status: () => invoke('status'), startAudio: uid => invoke('audio-start', uid), stopAudio: () => invoke('audio-stop'),
  muteAudio: value => invoke('audio-mute', value), privacy: value => invoke('privacy', value),
  startVideo: uid => invoke('video-start', uid), stopVideo: () => invoke('video-stop'),
  videoFrame: packet => invoke('video-frame', packet), activateCamera: () => invoke('camera-activate'),
  onCameraExtension: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('camera-extension-state', listener); return () => ipcRenderer.removeListener('camera-extension-state', listener); },
  startCloud: id => invoke('cloud-start', id), stopCloud: () => invoke('cloud-stop'), cloudHeartbeat: metrics => invoke('cloud-heartbeat', metrics),
  listCharacters: () => invoke('characters-list'), cloudState: () => invoke('cloud-state'), requestLoginCode: (method, id) => invoke('account-code', method, id), login: (method, id, code) => invoke('account-login', method, id, code), logout: () => invoke('account-logout'), importCharacter: () => invoke('characters-import'), removeCharacter: id => invoke('characters-remove', id),
  cloudDiagnostic: value => invoke('cloud-diagnostic', value),
  onCloudDiagnostic: callback => { const listener = (_, value) => callback(value); ipcRenderer.on('cloud-diagnostic-state', listener); return () => ipcRenderer.removeListener('cloud-diagnostic-state', listener); },
  onCloud: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('cloud-state', listener); return () => ipcRenderer.removeListener('cloud-state', listener); },
  onVideo: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('video-state', listener); return () => ipcRenderer.removeListener('video-state', listener); },
  clipMicPermission: () => invoke('clip-mic-permission'), saveClip: bytes => invoke('clip-save', bytes),
  cameraPermission: () => invoke('camera-permission'), installAudio: () => invoke('install-audio'),
  openSettings: kind => invoke('open-settings', kind), openGuide: () => invoke('open-guide'),
  onAudio: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('audio-state', listener); return () => ipcRenderer.removeListener('audio-state', listener); }
});
