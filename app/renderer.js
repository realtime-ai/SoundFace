'use strict';
const $ = id => document.getElementById(id);
const api = window.soundface;
let audio = { running: false, muted: false, privacy: false }, video = { running: false, submitted: 0, dropped: 0 }, cameraAvailable = false, installed = false, stream = null, busy = false, cameraGeneration = 0;
let cameraInstall = { phase: 'idle' };
function drawCameraInstall() {
  const pending = ['activating', 'awaiting_approval'].includes(cameraInstall.phase);
  $('camera-activate').disabled = busy || pending || video.running || !cameraInstall.installEntitlement || cameraInstall.phase === 'unavailable';
  $('camera-activate').textContent = pending ? '正在启用…' : '启用摄像头组件';
  const signature = !cameraInstall.installEntitlement ? '本机功能验证包 · 激活扩展请使用专用摄像头测试包' : cameraInstall.team && cameraInstall.team === cameraInstall.extensionTeam ? '团队签名已配置' : 'ad-hoc 开发签名 · 仅用于专用测试环境';
  $('camera-activation-status').textContent = (cameraInstall.message || signature) + (cameraInstall.domain ? ` (${cameraInstall.domain} ${cameraInstall.code})` : '');
}
function productMessage(text) { return String(text || '').replace(/Vidu/gi, '云端服务').replace(/阿里云 RTC/g, '实时连接'); }
function message(text) { $('message').textContent = productMessage(text); $('message').hidden = !text; }
function draw() {
  const probing = video.running && video.inputUID === 'vidu-probe';
  $('video-toggle').disabled = busy || audio.privacy || probing || (!video.running && (!cameraAvailable || !$('video-input').value));
  $('video-toggle').textContent = video.running && !probing ? '停止虚拟摄像头' : '开启虚拟摄像头';
  $('video-input').disabled = video.running || audio.privacy || busy;
  $('video-badge').textContent = probing ? '本机验证中' : video.running ? (video.submitted > 0 ? '输出中' : '等待首帧') : cameraAvailable ? '设备可见' : '待激活';
  $('video-badge').className = 'tag ' + (video.running ? 'on' : cameraAvailable ? '' : 'warning');
  if (probing) $('video-detail').textContent = `生成画面 → 原生 BGRA / CMSampleBuffer：已转换 ${video.converted || 0} 帧，丢弃 ${video.dropped || 0} 帧。当前为本机验证，未向 CMIO 设备入队。`;
  else if (video.running) $('video-detail').textContent = `${video.inputUID === 'vidu' ? 'AI 生成画面' : video.inputUID === 'test-pattern' ? '本地动态测试画面（无云端费用）' : '本地原始画面'} → 虚拟摄像头。已入队 ${video.submitted || 0} 帧，丢弃 ${video.dropped || 0} 帧；入队计数不代表会议已收到画面。`;
  else $('video-detail').textContent = cameraAvailable ? '会议中选择 SoundFace Camera。停止输出时将显示隐私画面。' : '请先在“组件与诊断”中启用摄像头组件。';
  $('video-probe').textContent = probing ? '停止帧链路检查' : '检查生成帧链路';
  $('meeting-readiness').textContent = `摄像头${cameraAvailable ? '已就绪' : '需要启用组件'} · 虚拟麦${installed ? '已就绪' : '需要安装组件'}。画面与声音可以独立开启。`;
  drawCameraInstall();
  $('audio-toggle').textContent = audio.running ? '停止虚拟麦' : '开启虚拟麦';
  $('audio-toggle').disabled = busy || audio.privacy || (!audio.running && (!installed || !$('audio-input').value));
  $('audio-input').disabled = busy || audio.running || audio.privacy;
  $('mute').disabled = busy || !audio.running;
  $('mute').textContent = audio.muted ? '取消静音' : '静音';
  $('mute').setAttribute('aria-pressed', String(audio.muted));
  $('audio-badge').textContent = audio.running ? (audio.muted ? '已静音' : '路由运行中') : '未开启';
  $('audio-badge').className = 'tag' + (audio.running && !audio.muted ? ' on' : '');
  document.querySelector('.sound-visual').classList.toggle('on', audio.running && !audio.muted);
  const db = value => Number.isFinite(value) && value > 0 ? Math.max(-96, 20 * Math.log10(value)).toFixed(1) : '−∞';
  const rates = audio.levels?.inputSampleRate && audio.levels.inputSampleRate !== audio.levels.sampleRate ? `当前输入 ${audio.levels.inputSampleRate / 1000} → 输出 ${audio.levels.sampleRate / 1000} kHz` : `${audio.levels?.sampleRate / 1000} kHz`;
  $('audio-levels').textContent = audio.running ? audio.levels ? `输入 ${db(audio.levels.inputPeak)} / 输出 ${db(audio.levels.outputPeak)} dBFS · ${rates}` : '等待音频帧…' : '尚未采集音频';
  $('privacy-text').textContent = audio.privacy ? '退出隐私暂停' : '隐私暂停';
  $('privacy').classList.toggle('active', audio.privacy);
  $('privacy').setAttribute('aria-pressed', String(audio.privacy));
  $('privacy-slate').hidden = !audio.privacy;
  $('camera-toggle').disabled = audio.privacy;
  $('camera-toggle').textContent = stream ? '关闭镜头' : '开启镜头';
  $('camera-input').disabled = Boolean(stream) || audio.privacy;
  $('preview-badge').textContent = audio.privacy ? '已暂停' : stream ? '镜头就绪' : '待机';
  $('preview-label').textContent = audio.privacy ? '隐私暂停 · 无采集' : '输出画面预览';
  $('summary').textContent = `${audio.running ? audio.muted ? '虚拟麦已静音' : '虚拟麦路由运行中' : '虚拟麦未开启'} · ${probing ? '生成帧本机验证' : video.running ? '虚拟摄像头输出中' : stream ? '摄像头本地预览' : '摄像头未采集'}`;
  if (typeof cloudDraw === 'function') cloudDraw();
}
async function run(action) {
  if (busy) return;
  busy = true; draw();
  try { message(''); await action(); } catch (error) { message(error.message); }
  finally { busy = false; draw(); }
}
async function refresh() {
  const status = await api.status(); audio = status.audio; video = status.video; cameraAvailable = status.camera.deviceVisible; cameraInstall = status.cameraExtension;
  installed = status.devices.installed && status.devices.internalOutput;
  const select = $('audio-input'), previous = select.value;
  select.replaceChildren();
  for (const item of status.devices.inputs.filter(item => !item.uid.startsWith('SoundFace'))) {
    const option = document.createElement('option'); option.value = item.uid; option.textContent = item.name; select.append(option);
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  else if ([...select.options].some(option => option.value === 'BuiltInMicrophoneDevice')) select.value = 'BuiltInMicrophoneDevice';
  if (audio.running) select.value = audio.inputUID;
  $('driver-status').textContent = installed ? '输入与内部输出均已被系统枚举' : '系统尚未加载 SoundFace 音频组件';
  $('driver-dot').classList.toggle('on', installed);
  $('install').textContent = installed ? '重新安装组件' : '安装音频组件';
  const previousVideo = $('video-input').value; $('video-input').replaceChildren();
  const generated = document.createElement('option'); generated.value = 'vidu'; generated.textContent = '数字人画面'; $('video-input').append(generated);
  const testPattern = document.createElement('option'); testPattern.value = 'test-pattern'; testPattern.textContent = '本地测试画面 · 免费'; $('video-input').append(testPattern);
  for (const camera of status.camera.inputs) {
    const option = document.createElement('option'); option.value = camera.uid; option.textContent = camera.name + ' · 原始画面'; $('video-input').append(option);
  }
  if ([...$('video-input').options].some(option => option.value === previousVideo)) $('video-input').value = previousVideo;
  if (video.running && video.inputUID !== 'vidu-probe') $('video-input').value = video.inputUID;
  $('camera-status').textContent = status.camera.deviceVisible ? '在会议软件中选择此摄像头' : '摄像头组件尚未启用';
  if (!cameraAvailable) $('camera-setup').open = true;
  draw();
}
function stopCamera() {
  cameraGeneration++;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  $('camera-preview').srcObject = null; $('camera-preview').hidden = true; $('preview-empty').hidden = false; draw();
}
async function startCamera() {
  const generation = ++cameraGeneration;
  if (!await api.cameraPermission()) throw new Error('摄像头权限未开启，请在系统设置中允许 SoundFace。');
  if (generation !== cameraGeneration || audio.privacy) return;
  const deviceId = $('camera-input').value;
  const next = await SoundFaceCameraInput.open(navigator.mediaDevices, deviceId);
  if (generation !== cameraGeneration || audio.privacy) { next.getTracks().forEach(track => track.stop()); return; }
  stream = next; $('camera-preview').srcObject = stream; $('camera-preview').hidden = false;
  stream.getVideoTracks()[0].addEventListener('ended', () => { stopCamera(); message('摄像头已断开，请重新选择设备。'); });
  const devices = await navigator.mediaDevices.enumerateDevices();
  const selected = stream.getVideoTracks()[0].getSettings().deviceId;
  $('camera-input').replaceChildren();
  for (const device of SoundFaceCameraInput.list(devices)) {
    const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || '摄像头'; $('camera-input').append(option);
  }
  $('camera-input').value = selected; draw();
}
$('audio-toggle').onclick = () => run(async () => {
  if (audio.running) await api.stopAudio();
  else {
    message('正在开启麦克风。如 macOS 弹出权限提示，请选择“允许”。');
    audio = await api.startAudio($('audio-input').value); message('');
  }
});
$('audio-input').onchange = draw;
$('video-input').onchange = draw;
$('video-toggle').onclick = () => run(async () => { if (video.running) await api.stopVideo(); else if ($('video-input').value === 'vidu') await startGeneratedOutput(); else video = await api.startVideo($('video-input').value); });
$('video-probe').onclick = () => run(async () => { if (video.running) await api.stopVideo(); else video = await api.startVideo('vidu-probe'); });
$('camera-activate').onclick = () => run(async () => { cameraInstall = await api.activateCamera(); });
$('camera-refresh').onclick = () => run(refresh);
api.onCameraExtension(state => { cameraInstall = state; drawCameraInstall(); if (state.phase === 'activated') void run(refresh); });
$('mute').onclick = () => run(async () => { audio = await api.muteAudio(!audio.muted); });
$('refresh').onclick = () => run(refresh);
$('install').onclick = () => run(async () => message(await api.installAudio()));
$('privacy').onclick = async () => {
  const next = !audio.privacy;
  if (next) { audio.privacy = true; stopCamera(); if (typeof endCloud === 'function') void endCloud(); draw(); }
  try { audio = await api.privacy(next); if (next) message('采集已停止。退出隐私暂停后，请手动重新开启所需设备。'); }
  catch (error) { message(error.message); }
  draw();
};
$('camera-toggle').onclick = () => run(async () => { if (stream) stopCamera(); else await startCamera(); });
$('mic-settings').onclick = () => run(() => api.openSettings('microphone'));
$('guide').onclick = () => $('meeting-dialog').showModal();
$('close-meeting').onclick = () => $('meeting-dialog').close();
$('nav-studio').onclick = () => $('stage-column').scrollTo({ top: 0, behavior: 'smooth' });
$('nav-characters').onclick = () => $('character-library').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
$('cloud-flow').onclick = () => $('cloud-dialog').showModal();
$('close-dialog').onclick = () => $('cloud-dialog').close();
api.onVideo(value => { video = value; if (value.error) message(value.error); draw(); });
api.onAudio(value => { audio = value; if (value.error) message(value.error); draw(); });
window.addEventListener('beforeunload', stopCamera);
navigator.mediaDevices.addEventListener('devicechange', () => { if (!busy) run(refresh); });
run(refresh);
