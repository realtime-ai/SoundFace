'use strict';
const $ = id => document.getElementById(id);
const api = window.soundface;
let audio = { running: false, muted: false, privacy: false }, video = { running: false, submitted: 0, dropped: 0 }, cameraAvailable = false, installed = false, stream = null, busy = false, cameraGeneration = 0;
let cameraInstall = { phase: 'idle' };
function drawCameraInstall() {
  const pending = ['activating', 'awaiting_approval'].includes(cameraInstall.phase);
  $('camera-activate').disabled = busy || pending || video.running || !cameraInstall.installEntitlement || cameraInstall.phase === 'unavailable';
  $('camera-activate').textContent = pending ? '正在安装…' : '安装虚拟摄像头';
  const signature = !cameraInstall.installEntitlement ? '本机功能验证包 · 激活扩展请使用专用摄像头测试包' : cameraInstall.team && cameraInstall.team === cameraInstall.extensionTeam ? '团队签名已配置' : 'ad-hoc 开发签名 · 仅用于专用测试环境';
  $('camera-activation-status').textContent = cameraInstall.message || '';
  $('camera-signing-status').textContent = signature + (cameraInstall.domain ? ` (${cameraInstall.domain} ${cameraInstall.code})` : '');
}
function productMessage(text) { return String(text || '').replace(/Vidu/gi, '服务').replace(/阿里云 RTC/g, '实时连接'); }
// `kind` tags a message so later code can recognise it without comparing text.
function message(text, kind = '') { $('message').textContent = productMessage(text); $('message').dataset.kind = text ? kind : ''; $('message').hidden = !text; }
function draw() {
  const probing = video.running && video.inputUID === 'vidu-probe';
  // Support-only raw camera output (给客服看的信息 → 排查用). Generated and test output have their own controls.
  const rawRunning = video.running && !['vidu', 'vidu-probe', 'test-pattern'].includes(video.inputUID);
  $('raw-output').hidden = !$('show-raw-camera').checked && !rawRunning;
  $('video-toggle').disabled = busy || audio.privacy || (video.running ? !rawRunning : (!cameraAvailable || !$('video-input').value));
  $('video-toggle').textContent = rawRunning ? '停止送出真实摄像头' : '送出真实摄像头（会露脸）';
  $('video-input').disabled = video.running || audio.privacy || busy;
  if (probing) $('video-diagnostic').textContent = `生成画面 → 原生 BGRA / CMSampleBuffer：已转换 ${video.converted || 0} 帧，丢弃 ${video.dropped || 0} 帧。当前为本机验证，未向 CMIO 设备入队。`;
  else if (video.running) $('video-diagnostic').textContent = `正在送出：${video.inputUID === 'vidu' ? '数字人画面' : video.inputUID === 'test-pattern' ? '测试画面' : '真实摄像头'} · 已入队 ${video.submitted || 0} 帧，丢弃 ${video.dropped || 0} 帧；入队计数不代表会议已收到画面。`;
  else $('video-diagnostic').textContent = '';
  $('video-probe').textContent = probing ? '停止检查' : '检查画面传输';
  $('meeting-readiness').textContent = `虚拟摄像头：${cameraAvailable ? '已就绪' : '还没安装'} · 虚拟麦克风：${installed ? '已就绪' : '还没安装'}。`;
  drawCameraInstall();
  $('audio-toggle').textContent = audio.running ? '关闭虚拟麦克风' : '开启虚拟麦克风';
  $('audio-toggle').disabled = busy || audio.privacy || (!audio.running && (!installed || !$('audio-input').value));
  $('audio-input').disabled = busy || audio.running || audio.privacy;
  $('mute').disabled = busy || !audio.running;
  $('mute').textContent = audio.muted ? '取消静音' : '静音';
  $('mute').setAttribute('aria-pressed', String(audio.muted));
  $('audio-badge').textContent = audio.running ? (audio.muted ? '已静音' : '已开启') : '未开启';
  $('audio-badge').className = 'tag' + (audio.running && !audio.muted ? ' on' : '');
  document.querySelector('.sound-visual').classList.toggle('on', audio.running && !audio.muted);
  const db = value => Number.isFinite(value) && value > 0 ? Math.max(-96, 20 * Math.log10(value)).toFixed(1) : '−∞';
  const rates = audio.levels?.inputSampleRate && audio.levels.inputSampleRate !== audio.levels.sampleRate ? `当前输入 ${audio.levels.inputSampleRate / 1000} → 输出 ${audio.levels.sampleRate / 1000} kHz` : `${audio.levels?.sampleRate / 1000} kHz`;
  $('audio-levels').textContent = audio.running ? audio.muted ? '已静音' : '正在把你的声音送到虚拟麦克风' : '麦克风未开启';
  $('audio-diagnostic').textContent = audio.running ? audio.levels ? `输入 ${db(audio.levels.inputPeak)} / 输出 ${db(audio.levels.outputPeak)} dBFS · ${rates}` : '等待音频帧…' : '';
  $('privacy-text').textContent = audio.privacy ? '退出隐私暂停' : '隐私暂停';
  $('privacy').classList.toggle('active', audio.privacy);
  $('privacy').setAttribute('aria-pressed', String(audio.privacy));
  $('privacy-slate').hidden = !audio.privacy;
  $('camera-toggle').disabled = audio.privacy;
  $('camera-toggle').textContent = stream ? '关闭摄像头' : '开启摄像头';
  $('camera-input').disabled = Boolean(stream) || audio.privacy;
  $('preview-badge').textContent = audio.privacy ? '已暂停' : stream ? '摄像头已开启' : '未开启';
  $('preview-label').textContent = audio.privacy ? '隐私暂停中 · 摄像头和麦克风都已关闭' : '观众看到的画面';
  $('summary').textContent = `${audio.running ? audio.muted ? '虚拟麦克风已静音' : '虚拟麦克风已开启' : '虚拟麦克风未开启'} · ${probing ? '检查中' : video.running ? '虚拟摄像头已开启' : stream ? '摄像头预览中' : '摄像头未开启'}`;
  if (typeof cloudDraw === 'function') cloudDraw();
  if (typeof clipDraw === 'function') clipDraw();
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
  $('driver-status').textContent = installed ? '虚拟麦克风已安装' : '还没安装虚拟麦克风';
  $('driver-dot').classList.toggle('on', installed);
  $('install').textContent = installed ? '重新安装虚拟麦克风' : '安装虚拟麦克风';
  const previousVideo = $('video-input').value; $('video-input').replaceChildren();
  // Raw camera output is a support-only option: listed only when enabled in 给客服看的信息.
  for (const camera of $('show-raw-camera').checked ? status.camera.inputs : []) {
    const option = document.createElement('option'); option.value = camera.uid; option.textContent = camera.name + ' · 你的真实画面（会露脸）'; $('video-input').append(option);
  }
  if ([...$('video-input').options].some(option => option.value === previousVideo)) $('video-input').value = previousVideo;
  if (video.running && [...$('video-input').options].some(option => option.value === video.inputUID)) $('video-input').value = video.inputUID;
  $('camera-system-status').textContent = status.camera.message || '';
  draw();
}
function stopCamera() {
  cameraGeneration++;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  $('camera-preview').srcObject = null; $('camera-preview').hidden = true; $('preview-empty').hidden = false; draw();
}
async function startCamera() {
  const generation = ++cameraGeneration;
  if (!await api.cameraPermission()) throw new Error('没有摄像头权限。请到“系统设置 → 隐私与安全性 → 摄像头”里允许 SoundFace。');
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
    message('正在开启麦克风。如果电脑弹出询问，请点“允许”。');
    audio = await api.startAudio($('audio-input').value); message('');
  }
});
$('audio-input').onchange = draw;
$('video-input').onchange = draw;
$('video-toggle').onclick = () => run(async () => { if (video.running) await api.stopVideo(); else if ($('video-input').value) video = await api.startVideo($('video-input').value); });
$('show-raw-camera').onchange = () => run(async () => { if (!$('show-raw-camera').checked && video.running && !['vidu', 'vidu-probe', 'test-pattern'].includes(video.inputUID)) await api.stopVideo(); await refresh(); });
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
  try { audio = await api.privacy(next); if (next) message('已进入隐私暂停，摄像头和麦克风都关了。退出后需要你自己重新开启。'); }
  catch (error) { message(error.message); }
  draw();
};
$('camera-toggle').onclick = () => run(async () => { if (stream) stopCamera(); else await startCamera(); });
$('mic-settings').onclick = () => run(() => api.openSettings('microphone'));
$('guide').onclick = () => $('meeting-dialog').showModal();
$('close-meeting').onclick = () => $('meeting-dialog').close();
$('nav-studio').onclick = () => $('stage-column').scrollTo({ top: 0, behavior: 'smooth' });
$('nav-characters').onclick = () => $('character-library').scrollIntoView({ behavior: 'smooth', block: 'start' });
$('cloud-flow').onclick = () => $('cloud-dialog').showModal();
$('close-dialog').onclick = () => $('cloud-dialog').close();
api.onVideo(value => { video = value; if (value.error) message(value.error); draw(); });
api.onAudio(value => { audio = value; if (value.error) message(value.error); draw(); });
window.addEventListener('beforeunload', stopCamera);
navigator.mediaDevices.addEventListener('devicechange', () => { if (!busy) run(refresh); });
run(refresh);
