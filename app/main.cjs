const { app, BrowserWindow, ipcMain, shell, systemPreferences, session, dialog, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { AudioBridge } = require('./audio.cjs');
const { CaptureController } = require('./capture-controller.cjs');
const { CloudSession } = require('./cloud-session.cjs');
const { ProxyBackend } = require('./cloud-backend.cjs');
const { CameraExtension } = require('./camera-extension.cjs');
const { GeneratedVideoRelay } = require('./generated-video.cjs');
const { CharacterLibrary, loadBuiltinManifest } = require('./characters.cjs');
const { loadServiceConfig } = require('./service-config.cjs');
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
  let builtins = [];
  try { builtins = loadBuiltinManifest(path.join(root, 'assets/characters/manifest.json'), path.join(root, 'assets')); }
  catch (error) { console.error('内置角色清单读取失败：' + error.message); }
  characters = new CharacterLibrary({
    builtins,
    directory: path.join(app.getPath('userData'), 'characters'), defaultImage: path.join(root, 'assets/default-character.jpg'), trash: file => shell.trashItem(file),
    normalize: (data, size) => {
      let image = nativeImage.createFromBuffer(data);
      if (image.isEmpty()) throw new Error('图片无法读取，请换一张 JPG 或 PNG 图片。');
      if (Math.max(size.width, size.height) > 1024) image = image.resize(size.width >= size.height ? { width: 1024, quality: 'best' } : { height: 1024, quality: 'best' });
      return { image: image.toJPEG(90), thumbnail: 'data:image/jpeg;base64,' + image.resize({ width: 160, quality: 'best' }).toJPEG(75).toString('base64') };
    }
  });
  const serviceConfig = loadServiceConfig({ isPackaged: app.isPackaged });
  const backend = new ProxyBackend({ baseUrl: serviceConfig.baseUrl });
  cloud = new CloudSession({ backend, image: id => characters.image(id), characterExists: id => characters.has(id) });
  // Login token persisted with the OS keychain-backed safeStorage; never sent to the renderer.
  const tokenFile = path.join(app.getPath('userData'), 'account-token.bin');
  const saveToken = token => { try { if (!token) fs.rmSync(tokenFile, { force: true }); else if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(tokenFile, safeStorage.encryptString(token), { mode: 0o600 }); } catch { /* Stay logged in for this run only. */ } };
  const publishAccount = () => cloud.publish({});
  if (serviceConfig.devUser) backend.login('dev', { name: serviceConfig.devUser }).then(publishAccount).catch(error => console.error('SoundFace 开发登录失败：' + error.message));
  else {
    try { if (fs.existsSync(tokenFile) && safeStorage.isEncryptionAvailable()) backend.restore(safeStorage.decryptString(fs.readFileSync(tokenFile))); } catch { saveToken(''); }
    if (backend.token) backend.refreshAccount().then(publishAccount).catch(error => { if (error.status === 401) { backend.logout(); saveToken(''); } publishAccount(); });
  }
  const loginFields = { sms: 'phone', email: 'email' };
  const loginBody = (method, id, code) => {
    const field = loginFields[method];
    if (!field || typeof id !== 'string' || id.length > 254 || (code !== undefined && (typeof code !== 'string' || code.length > 10))) throw new Error('输入无效');
    return code === undefined ? { [field]: id } : { [field]: id, code };
  };
  const requireNoSession = () => { if (cloud.starting || cloud.stopping || cloud.live || cloud.state.billing === 'unknown') throw new Error('请先结束当前数字人会话。'); };
  handle('account-code', (method, id) => backend.requestCode(method, loginBody(method, id)));
  handle('account-login', async (method, id, code) => { requireNoSession(); const account = await backend.login(method, loginBody(method, id, code)); saveToken(backend.token); publishAccount(); return account.name; });
  handle('account-logout', () => { requireNoSession(); backend.logout(); saveToken(''); publishAccount(); return true; });
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
    // Video for the camera; audio only for the clip recorder's microphone track.
    callback(webContents === window?.webContents && details.isMainFrame && details.requestingUrl === uiURL && permission === 'media' && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'video' || type === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => webContents === window?.webContents && details.isMainFrame && details.requestingUrl === uiURL && permission === 'media' && (details.mediaType === 'video' || details.mediaType === 'audio'));
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
  // Separate from 'status' so the library loads even if a native helper is unavailable.
  handle('characters-list', () => characters.list());
  handle('cloud-state', () => ({ ...cloud.snapshot(), transport: rtcTransport }));
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
  handle('clip-mic-permission', () => systemPreferences.askForMediaAccess('microphone'));
  handle('clip-save', async bytes => {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 512 * 1024 * 1024) throw new Error('片段数据无效');
    if (Buffer.from(bytes.subarray(4, 8)).toString('latin1') !== 'ftyp') throw new Error('片段不是 MP4 格式');
    const now = new Date(), pad = value => String(value).padStart(2, '0'), stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    // Dev-only: automated checks save without a native dialog.
    if (!app.isPackaged && process.env.SOUNDFACE_CLIP_DIR) { const file = path.join(process.env.SOUNDFACE_CLIP_DIR, `SoundFace-${stamp}.mp4`); await fs.promises.writeFile(file, bytes); return file; }
    const result = await dialog.showSaveDialog(window, { title: '保存竖屏片段', buttonLabel: '保存', defaultPath: path.join(app.getPath('videos'), `SoundFace-${stamp}.mp4`), filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, bytes);
    return result.filePath;
  });
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
  window = new BrowserWindow({ width: 1240, height: 900, minWidth: 960, minHeight: 720, title: 'SoundFace', icon: path.join(root, 'assets/icons/soundface.png'), backgroundColor: '#080c18', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  if (!app.isPackaged && process.platform === 'darwin') app.dock.setIcon(path.join(root, 'assets/icons/soundface.png'));
  // Only the live output popup may open: a blank same-origin window that the
  // renderer draws into. Every other window.open is denied.
  window.webContents.setWindowOpenHandler(({ url, frameName }) => url === 'about:blank' && frameName === 'soundface-live'
    ? { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 540, minWidth: 320, minHeight: 180, title: 'SoundFace 直播画面', frame: false, backgroundColor: '#000000', show: true, fullscreenable: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } } }
    : { action: 'deny' });
  window.webContents.on('did-create-window', child => {
    child.setAspectRatio(16 / 9);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', event => event.preventDefault());
  });
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
