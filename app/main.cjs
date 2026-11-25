const { app, BrowserWindow, ipcMain, shell, systemPreferences, session, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { AudioBridge } = require('./audio.cjs');
const { CaptureController } = require('./capture-controller.cjs');
const { ViduSession } = require('./vidu.cjs');
const { CameraExtension } = require('./camera-extension.cjs');
const { GeneratedVideoRelay } = require('./generated-video.cjs');
const { CharacterLibrary } = require('./characters.cjs');
const { loadCloudKey } = require('./service-config.cjs');
const { ConnectionTrace } = require('./connection-trace.cjs');

const root = path.join(__dirname, '..');
const resources = app.isPackaged ? process.resourcesPath : path.join(root, 'build');
const uiURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const diagnosing = process.argv.includes('--diagnose');
let window, bridge, videoBridge, audio, video, cloud, characters, cameraExtension, generatedVideo, quitting = false;
if (!diagnosing && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { window?.show(); window?.focus(); });
function sendState(channel, state) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, state);
}
function validateSender(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('请求来源无效');
}
function handle(name, callback) {
  ipcMain.handle(name, async (event, ...args) => {
    validateSender(event);
    try { return { ok: true, value: await callback(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}
function inputUID(uid) { if (typeof uid !== 'string' || !uid || uid.length > 512 || uid.startsWith('SoundFace')) throw new Error('请选择物理输入设备'); return uid; }
const cameraBuilt = () => fs.existsSync(app.isPackaged ? path.join(resources, '../Library/SystemExtensions/app.soundface.camera.systemextension') : path.join(resources, 'app.soundface.camera.systemextension'));
app.whenReady().then(async () => {
  bridge = new AudioBridge(path.join(resources, 'soundface-audio'));
  videoBridge = new AudioBridge(path.join(resources, 'soundface-video'), '视频');
  let cameraNative;
  try { cameraNative = require(path.join(resources, 'soundface-camera.node')); } catch { /* Report unavailable through status. */ }
  cameraExtension = new CameraExtension(cameraNative);
  characters = new CharacterLibrary({
    directory: path.join(app.getPath('userData'), 'characters'), defaultImage: path.join(root, 'assets/default-character.jpg'), trash: file => shell.trashItem(file),
    normalize: (data, size) => {
      let image = nativeImage.createFromBuffer(data);
      if (image.isEmpty()) throw new Error('图片无法读取，请换一张 JPG 或 PNG 图片。');
      if (Math.max(size.width, size.height) > 1024) image = image.resize(size.width >= size.height ? { width: 1024, quality: 'best' } : { height: 1024, quality: 'best' });
      return { image: image.toJPEG(90), thumbnail: 'data:image/jpeg;base64,' + image.resize({ width: 160, quality: 'best' }).toJPEG(75).toString('base64') };
    }
  });
  cloud = new ViduSession({ key: loadCloudKey(app.isPackaged ? path.join(resources, 'cloud-runtime.json') : path.join(root, '.soundface-local/cloud.json')), image: id => characters.image(id), characterExists: id => characters.has(id) });
  const connectionTrace = new ConnectionTrace();
  const rtcTransport = process.env.SOUNDFACE_RTC_TRANSPORT === 'tcp' ? 'tcp' : 'auto';
  const persistConnectionTrace = () => {
    const state = cloud.snapshot();
    const diagnostic = { updatedAt: Date.now(), liveId: state.liveId || null, phase: state.phase, billing: state.billing, frames: state.frames, closeReason: String(state.closeReason || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80), traceId: String(state.traceId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80), transport: rtcTransport, events: connectionTrace.snapshot() };
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'cloud-diagnostic.json'), JSON.stringify(diagnostic, null, 2), { mode: 0o600 }); } catch { /* Diagnostics cannot interrupt media or hangup. */ }
  };
  if (diagnosing) {
    try {
      const [devices, cameras] = await Promise.all([bridge.command('list'), videoBridge.command('list')]);
      console.log(JSON.stringify({ app: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, devices, cameras, cameraExtension: cameraExtension.snapshot(), microphonePermission: systemPreferences.getMediaAccessStatus('microphone'), cameraPermission: systemPreferences.getMediaAccessStatus('camera') }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    bridge.close(); videoBridge.close(); app.quit(); return;
  }
  audio = new CaptureController(bridge, () => systemPreferences.askForMediaAccess('microphone'));
  video = new CaptureController(videoBridge, async uid => {
    if (uid === 'vidu-probe') return true;
    if (!(await videoBridge.command('list')).installed) throw new Error('SoundFace Camera 尚未激活，请先申请激活并检查系统返回的状态。');
    if (['vidu', 'test-pattern'].includes(uid)) return true;
    return systemPreferences.askForMediaAccess('camera');
  });
  audio.on('state', state => sendState('audio-state', state));
  generatedVideo = new GeneratedVideoRelay(videoBridge, liveID => video.state.running && !video.state.privacy && (video.state.inputUID === 'test-pattern' ? video.state.frameLiveID === liveID : ['vidu', 'vidu-probe'].includes(video.state.inputUID) && ['waiting_frames', 'live'].includes(cloud.state.phase) && cloud.state.liveId === liveID));
  video.on('state', state => { if (!state.running) generatedVideo.disarm(); sendState('video-state', state); });
  cameraExtension.on('state', state => sendState('camera-extension-state', state));
  cloud.on('state', state => {
    if (['stopping', 'ended', 'error'].includes(state.phase)) {
      generatedVideo.disarm();
      if (video.state.running && ['vidu', 'vidu-probe'].includes(video.state.inputUID)) void video.stop().catch(() => {});
    }
    sendState('cloud-state', state);
    persistConnectionTrace();
    if (!app.isPackaged) console.log('SoundFace cloud', JSON.stringify(state));
  });
  handle('cloud-diagnostic', diagnostic => {
    // Explicit small allowlist, no raw SDK objects, URLs, tokens, or images.
    if (connectionTrace.record(diagnostic || {})) {
      persistConnectionTrace(); sendState('cloud-diagnostic-state', connectionTrace.snapshot());
    }
    return true;
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === window?.webContents && details.isMainFrame && details.requestingUrl === uiURL && permission === 'media' && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'video'));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => webContents === window?.webContents && details.isMainFrame && details.requestingUrl === uiURL && permission === 'media' && details.mediaType === 'video');
  handle('status', async () => {
    const [devices, cameras] = await Promise.all([bridge.command('list'), videoBridge.command('list')]);
    return {
      audio: audio.snapshot(), video: video.snapshot(), devices,
      permissions: { microphone: systemPreferences.getMediaAccessStatus('microphone'), camera: systemPreferences.getMediaAccessStatus('camera') },
      camera: { built: cameraBuilt(), deviceVisible: cameras.installed, inputs: cameras.inputs, message: cameras.installed ? '系统已枚举帧输入流 · 会议采集仍需验证' : '扩展构建版 · 未签名激活，尚不能在会议中采集' },
      cameraExtension: cameraExtension.snapshot(),
      cloud: { ...cloud.snapshot(), transport: rtcTransport }, cloudDiagnostics: connectionTrace.snapshot(), characters: characters.list()
    };
  });
  handle('audio-start', uid => audio.start(inputUID(uid)));
  handle('audio-stop', () => audio.stop());
  handle('audio-mute', muted => { if (typeof muted !== 'boolean') throw new Error('静音状态无效'); return audio.mute(muted); });
  handle('video-start', async uid => {
    generatedVideo.disarm();
    if (uid === 'test-pattern') {
      const liveID = 'local-test-' + randomUUID();
      await video.start(uid, { liveID });
      video.state.frameLiveID = liveID; video.state.frameToken = generatedVideo.arm(liveID);
      return video.publish();
    }
    if (!['vidu', 'vidu-probe'].includes(uid)) return video.start(inputUID(uid));
    const liveID = cloud.state.liveId;
    if (cloud.state.phase !== 'live' || !liveID) throw new Error('请先开始数字人验证，等待真实生成画面后再开启输出。');
    const state = await video.start(uid, { liveID });
    if (cloud.state.liveId !== liveID || cloud.state.phase !== 'live') { await video.stop(); throw new Error('数字人会话已结束，请重新开始。'); }
    video.state.frameToken = generatedVideo.arm(liveID); return video.publish();
  });
  handle('video-stop', () => { generatedVideo.disarm(); return video.stop(); });
  handle('video-frame', packet => generatedVideo.frame(packet));
  handle('camera-activate', () => {
    if (video.state.running) throw new Error('请先停止虚拟摄像头输出再申请激活。');
    return cameraExtension.activate();
  });
  const requireIdleCharacters = () => { if (cloud.starting || cloud.stopping || cloud.live || cloud.state.billing === 'unknown') throw new Error('请先停止数字人并确认云端会话结束。'); };
  handle('characters-import', async () => {
    requireIdleCharacters();
    const result = await dialog.showOpenDialog(window, { title: '添加角色参考图', buttonLabel: '添加角色', properties: ['openFile'], filters: [{ name: '角色参考图 · JPG / PNG', extensions: ['jpg', 'jpeg', 'png'] }] });
    if (result.canceled) return null;
    requireIdleCharacters();
    const character = characters.importFile(result.filePaths[0]);
    return { character, characters: characters.list() };
  });
  handle('characters-remove', id => { requireIdleCharacters(); return characters.remove(id); });
  handle('cloud-start', characterId => { if (audio.state.privacy) throw new Error('请先退出隐私暂停'); return cloud.start(characterId); });
  handle('cloud-stop', () => cloud.stop());
  handle('cloud-heartbeat', metrics => cloud.heartbeat(metrics));
  handle('privacy', async enabled => {
    if (typeof enabled !== 'boolean') throw new Error('隐私状态无效');
    if (enabled) generatedVideo.disarm();
    const results = await Promise.allSettled([audio.setPrivacy(enabled), video.setPrivacy(enabled), ...(enabled ? [cloud.stop('隐私暂停')] : [])]);
    const failed = results.find(item => item.status === 'rejected'); if (failed) throw failed.reason;
    return audio.snapshot();
  });
  handle('camera-permission', () => systemPreferences.askForMediaAccess('camera'));
  handle('install-audio', async () => {
    if (audio.state.running) throw new Error('请先停止麦克风输出再安装组件。');
    const installer = app.isPackaged ? path.join(resources, 'SoundFace-Microphone-dev.pkg') : path.join(root, 'dist/SoundFace-Microphone-dev.pkg');
    const error = await shell.openPath(installer); if (error) throw new Error('无法打开安装器，请重新构建安装包。');
    return '已打开 macOS 安装器。安装完成后刷新设备；若仍未出现，请保存工作并重启 Mac。';
  });
  handle('open-settings', kind => {
    const panel = { microphone: 'Privacy_Microphone', camera: 'Privacy_Camera' }[kind];
    if (!panel) throw new Error('设置类型无效');
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + panel);
  });
  handle('open-guide', () => shell.openPath(app.isPackaged ? path.join(resources, 'DEVELOPMENT.md') : path.join(root, 'docs/DEVELOPMENT.md')));
  window = new BrowserWindow({ width: 1240, height: 900, minWidth: 960, minHeight: 720, title: 'SoundFace', icon: path.join(root, 'assets/icons/soundface.png'), backgroundColor: '#f2f5f3', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  if (!app.isPackaged && process.platform === 'darwin') app.dock.setIcon(path.join(root, 'assets/icons/soundface.png'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { audio.close(); video.close(); void cloud.stop('界面已退出'); });
  window.webContents.on('unresponsive', () => { audio.close(); video.close(); void cloud.stop('界面失去响应'); });
  await window.loadURL(uiURL);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  bridge?.close(); videoBridge?.close();
  cameraExtension?.close(); generatedVideo?.disarm();
  // Await hangup and settlement, including an in-flight create request.
  Promise.resolve(cloud?.stop('应用退出')).finally(() => setTimeout(() => app.quit(), 150));
});
process.on('SIGTERM', () => app.quit());
