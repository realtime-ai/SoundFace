'use strict';
let cloudState = { phase: 'idle', billing: 'none', configured: false };
// Remembered character: first launch uses the default built-in one, later the last one used.
const CHARACTER_KEY = 'soundface.character', DEFAULT_CHARACTER = 'qinghe';
let character = (() => { try { return localStorage.getItem(CHARACTER_KEY) || DEFAULT_CHARACTER; } catch { return DEFAULT_CHARACTER; } })();
const rememberCharacter = () => { try { localStorage.setItem(CHARACTER_KEY, character); } catch { /* Not remembered this time. */ } };
const ensureCharacter = () => { if (!characters.some(item => item.id === character)) character = characters.some(item => item.id === DEFAULT_CHARACTER) ? DEFAULT_CHARACTER : characters[0]?.id || DEFAULT_CHARACTER; };
let characters = [{ id: 'qinghe', name: '青禾', thumbnail: '../assets/default-character.jpg', source: 'builtin', description: '自然清爽，保留你的动作与表情。' }], characterFilter = 'all';
let rtcTransport = 'auto', connectionEvents = [];
let rtcEngine = null, cloudGeneration = 0, heartbeatTimer = null, frameCallback = null, frameCount = 0, lastFrameAt = 0, awaitingFrameAt = 0;
const framePump = new RemoteFramePump({
  route: () => {
    if (!video.running || audio.privacy || !video.frameToken) return null;
    if (video.inputUID === 'test-pattern') return { liveID: video.frameLiveID, frameToken: video.frameToken, kind: 'test' };
    return ['vidu', 'vidu-probe'].includes(video.inputUID) && cloudState.phase === 'live' ? { liveID: cloudState.liveId, frameToken: video.frameToken } : null;
  },
  send: packet => api.videoFrame(packet),
  fail: async error => { await api.stopVideo().catch(() => {}); message('虚拟摄像头没有收到画面：' + error.message); }
});
const localTestSource = new LocalTestSource($('test-preview'));
const outputIntent = new GeneratedOutputIntent({ start: () => api.startVideo('vidu'), stop: () => api.stopVideo() });
const frameMetrics = () => ({ frames: frameCount, width: $('cloud-preview').videoWidth, height: $('cloud-preview').videoHeight });
async function attachGeneratedOutput(generation) {
  try {
    const state = await outputIntent.onFrame(() => api.cloudHeartbeat(frameMetrics()));
    if (state && generation === cloudGeneration) video = state;
  } catch (error) {
    if (generation === cloudGeneration) { message('虚拟摄像头开启失败：' + error.message); await endCloud('摄像头输出失败'); }
  } finally { draw(); }
}
document.addEventListener('securitypolicyviolation', event => {
  let origin = ''; try { origin = new URL(event.blockedURI).origin; } catch { origin = 'non-url'; }
  void api.cloudDiagnostic({ stage: 'csp-' + event.effectiveDirective, code: origin });
});
const cloudActive = () => ['creating', 'connecting', 'waiting_frames', 'live', 'stopping'].includes(cloudState.phase);
const cloudNames = { creating: '正在准备…', connecting: '正在连接…', waiting_frames: '等待数字人画面出现', live: '连接正常', stopping: '正在关闭…' };
// The single "virtual camera" control. It is on while a cloud session runs (or may still bill),
// or while the free test picture / support-only raw camera feeds SoundFace Camera.
const stopPending = () => cloudState.billing === 'unknown';
const testRunning = () => video.running && video.inputUID === 'test-pattern';
const directOutput = () => video.running && video.inputUID !== 'vidu' && video.inputUID !== 'vidu-probe';
const vcamOn = () => cloudActive() || stopPending() || directOutput();
const hms = seconds => { seconds = Math.max(0, Math.floor(seconds)); return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':'); };
let directStartedAt = 0, confirmingStop = false, pendingStart = false;
const clock = seconds => { seconds = Math.max(0, Math.floor(seconds)); return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`; };
function renderCharacters() {
  const grid = $('character-grid'); grid.replaceChildren();
  for (const item of characters.filter(item => characterFilter === 'all' || item.source === characterFilter)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'character-option'; button.dataset.character = item.id;
    const image = document.createElement('img'); image.src = item.thumbnail; image.alt = item.name + '角色照片';
    const info = document.createElement('span'); info.className = 'character-info';
    const name = document.createElement('strong'); name.textContent = item.name;
    const source = document.createElement('small'); source.textContent = item.source === 'builtin' ? (item.tag || '自带角色') : '我添加的角色';
    const check = document.createElement('span'); check.className = 'selection-check'; check.textContent = '✓';
    info.append(name, source); button.append(image, info, check); grid.append(button);
  }
  const add = document.createElement('button'); add.className = 'add-character'; add.dataset.action = 'import';
  const plus = document.createElement('span'); plus.className = 'import-plus'; plus.textContent = '+';
  const title = document.createElement('strong'); title.textContent = '添加角色';
  const hint = document.createElement('small'); hint.textContent = 'JPG 或 PNG 图片，不超过 4 MB';
  add.append(plus, title, hint); grid.append(add);
  $('character-count').textContent = characters.length;
  document.querySelectorAll('[data-character-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.characterFilter === characterFilter)));
}
function cloudDraw() {
  const active = cloudActive();
  const connectionLabels = { 'attempt-start': '开始连接', 'rtc-joined': '已加入 RTC 房间', 'video-publish': '视频发布状态', 'rtc-connection': 'RTC 连接状态', 'render-online': '生成端上线', 'render-offline': '生成端离线', 'render-subscription': '生成视频订阅状态', 'first-frame': '收到生成首帧', 'start-error': '连接错误', 'stop': '停止请求' };
  const entries = connectionEvents.map(item => (connectionLabels[item.stage] || item.stage) + '：' + item.code);
  if (cloudState.closeReason) entries.push('服务端结束原因：' + cloudState.closeReason);
  if (cloudState.traceId) entries.push('追踪 ID：' + cloudState.traceId);
  $('cloud-connection-detail').textContent = entries.join('；') || '尚未连接数字人服务。';
  $('video-probe').disabled = busy || audio.privacy || (video.running ? video.inputUID !== 'vidu-probe' : cloudState.phase !== 'live');
  const stats = framePump.stats;
  $('frame-metrics').textContent = stats.forwarded ? `本次运行累计传递 ${stats.forwarded} 帧 · 当前/最近一轮原生转换 ${video.converted || 0} 帧 · 平均读帧/编码 ${stats.encodeMs.toFixed(1)} ms · IPC/原生处理 ${stats.bridgeMs.toFixed(1)} ms（非端到端延迟）` : '尚未向虚拟摄像头提交生成帧。开启虚拟摄像头后，这里会显示实际转发计数。';
  const on = vcamOn(), locked = active || stopPending();
  document.querySelectorAll('[data-character]').forEach(button => {
    button.classList.toggle('selected', button.dataset.character === character);
    button.setAttribute('aria-pressed', String(button.dataset.character === character));
    button.disabled = locked;
  });
  const selected = characters.find(item => item.id === character) || characters[0];
  $('selected-character').textContent = selected.name;
  $('character-description').textContent = selected.description || (selected.source === 'builtin' ? (selected.tag || '自带角色') : '我添加的角色');
  for (const id of ['selected-character-image', 'idle-character-image']) if ($(id).getAttribute('src') !== selected.thumbnail) $(id).src = selected.thumbnail;
  $('remove-character').hidden = selected.source !== 'custom'; $('remove-character').disabled = locked;
  $('change-character').disabled = locked; $('library-lock').hidden = !locked;
  document.querySelector('[data-action="import"]').disabled = locked;
  const account = cloudState.account;
  $('session-limit').textContent = account ? `${account.name} · 剩余 ${Math.floor(account.remainingSeconds / 60)} 分钟` : '登录后可查看剩余时长';
  $('recharge-open').hidden = !account;
  // State A: one button. Not logged in → it opens login and starts right after.
  const loggedIn = cloudState.configured && Boolean(account);
  $('cloud-toggle').textContent = pendingStart ? '登录后会自动开启…' : loggedIn ? '开启虚拟摄像头' : '登录后开启虚拟摄像头';
  $('cloud-toggle').disabled = busy || audio.privacy || on || (loggedIn && (!cameraAvailable || !characters.some(item => item.id === character)));
  const lastRun = cloudState.phase === 'ended' && !cloudState.frames ? (cloudState.closeReason === 'live_ended' ? '连接断了，没有出画面，没有扣分钟。' : '已关闭，没有出画面，没有扣分钟。')
    : cloudState.phase === 'error' ? '数字人暂时开不了，请过一会儿再点“开启虚拟摄像头”。' : '';
  const idleNote = audio.privacy ? '隐私暂停中。点右上角“退出隐私暂停”后，才能开启虚拟摄像头。' : loggedIn && !cameraAvailable ? '还没安装虚拟摄像头，请先点下面的“安装虚拟摄像头”。' : loggedIn ? lastRun : '';
  $('cloud-status').textContent = idleNote; $('cloud-status').hidden = !idleNote;
  const used = cloudState.billing === 'ended' && cloudState.frames > 0 && cloudState.billedSeconds != null ? `上次用了 ${clock(cloudState.billedSeconds)}。` : '';
  $('cloud-metrics').textContent = used; $('cloud-metrics').hidden = !used || Boolean(idleNote);
  $('camera-ready').hidden = !cameraAvailable; $('camera-install').hidden = cameraAvailable;
  // State B: running.
  if (testRunning() || directOutput()) { if (!directStartedAt) directStartedAt = Date.now(); } else directStartedAt = 0;
  if (!on) confirmingStop = false;
  $('vcam-card').dataset.state = on ? 'on' : 'idle';
  $('vcam-idle').hidden = on; $('vcam-live').hidden = !on; $('vcam-live-stats').hidden = !on; $('vcam-info').hidden = !on;
  $('vcam-dot').hidden = !on; $('vcam-icon').classList.toggle('gone', on);
  $('vcam-title').textContent = on ? (stopPending() && !active ? '虚拟摄像头还没完全关闭' : '虚拟摄像头已开启') : '虚拟摄像头';
  const outputOk = video.running && video.inputUID === 'vidu';
  const tag = stopPending() ? '还没完全停止' : active ? (cloudState.phase === 'live' && !outputOk ? (outputIntent.active ? '正在送到虚拟摄像头…' : '连接正常') : cloudNames[cloudState.phase] || '正在连接…') : testRunning() ? '测试画面 · 不扣分钟' : directOutput() ? '真实摄像头（排查用）' : '未开启';
  $('vcam-tag').textContent = tag;
  $('vcam-tag').className = 'tag' + (on ? (active && cloudState.phase === 'live' || directOutput() ? ' on' : ' warning') : '');
  if (on) {
    const firstFrameAt = active && cloudState.frames > 0 && cloudState.startedAt ? cloudState.startedAt + (cloudState.firstFrameMs || 0) : 0;
    $('vcam-elapsed').textContent = hms(firstFrameAt ? (Date.now() - firstFrameAt) / 1000 : directStartedAt ? (Date.now() - directStartedAt) / 1000 : 0);
    $('vcam-remaining').textContent = account ? Math.floor(account.remainingSeconds / 60) : '—';
    const note = stopPending() ? '还没完全停止，请再点一次停止' : active && !cloudState.frames ? '数字人画面出现后才开始扣分钟，没出画面不扣。' : testRunning() ? '正在送测试画面，不扣分钟。' : '';
    $('vcam-note').textContent = note; $('vcam-note').hidden = !note; $('vcam-note').classList.toggle('danger-note', stopPending());
    $('vcam-stop').textContent = stopPending() ? '再点一次停止' : testRunning() ? '关闭测试画面' : '关闭虚拟摄像头';
    $('vcam-stop').classList.toggle('retry', stopPending());
    $('vcam-stop').disabled = cloudState.phase === 'stopping' || busy;
    $('vcam-confirm').hidden = !confirmingStop || stopPending();
    $('vcam-confirm-text').textContent = testRunning() ? '确定关闭测试画面吗？关闭后，观众看到的是“稍后回来”画面。' : '确定关闭虚拟摄像头吗？关闭后，观众看到的是“稍后回来”画面。';
    $('privacy-big').disabled = audio.privacy;
    $('vcam-source').textContent = active || stopPending() ? '数字人画面' : testRunning() ? '测试画面（免费，不扣分钟）' : '你的真实画面（排查用，会露脸）';
    $('vcam-character-line').textContent = active || stopPending() ? `角色：${selected.name}（开启中不能切换）` : testRunning() ? '测试画面不用角色，也不连服务器。' : '只给客服排查用，观众能看到你的真实画面。';
  }
  // 高级 → 测试画面
  $('test-toggle').textContent = testRunning() ? '停止测试画面' : '把测试画面送到虚拟摄像头';
  $('test-toggle').disabled = busy || audio.privacy || (testRunning() ? false : (on || !cameraAvailable));
  $('test-badge').textContent = testRunning() ? '正在送出' : cameraAvailable ? '未开启' : '未安装虚拟摄像头';
  $('test-badge').className = 'tag' + (testRunning() ? ' on' : '');
  if (cloudState.frames > 0 || cloudState.billing === 'ended') {
    const elapsed = cloudState.startedAt ? Math.max(0, (Date.now() - cloudState.startedAt) / 1000).toFixed(0) : 0;
    $('cloud-diagnostic').textContent = `${cloudState.frames > 0 ? `${cloudState.width} × ${cloudState.height} · 已显示 ${cloudState.frames} 帧 · 首帧 ${(cloudState.firstFrameMs / 1000).toFixed(1)} 秒` : '尚未收到生成帧'}${active ? ` · 已运行 ${elapsed} 秒` : ''}${cloudState.billedSeconds != null ? ` · 账单 ${cloudState.billedSeconds} 秒 / ${cloudState.creditsCost} 积分` : ''}`;
  } else $('cloud-diagnostic').textContent = '';
  $('camera-toggle').disabled = active || audio.privacy;
  $('camera-input').disabled = active || Boolean(stream) || audio.privacy;
  $('preview-empty').querySelector('strong').textContent = active ? '正在准备数字人，请稍等几秒' : '让另一个你，走到镜头前';
  $('preview-empty').querySelector('p').textContent = active ? '你的真实画面只在右下角小窗里，数字人画面显示在这里' : '选一个角色，点“开启虚拟摄像头”';
  $('preview-empty').querySelector('span').textContent = active ? '正在连接，只上传摄像头画面，不上传声音' : stream ? '摄像头已开启，小窗只有你自己能看到' : '摄像头未开启';
  $('preview-badge').className = 'tag';
  if (active) {
    $('preview-badge').textContent = cloudState.phase === 'live' ? '实时生成' : '连接中';
    $('preview-badge').className = 'tag' + (cloudState.phase === 'live' ? ' on' : '');
    $('preview-label').textContent = video.running && video.inputUID === 'vidu' ? 'AI 合成 · 已送到 SoundFace Camera' : 'AI 合成 · 正在送到 SoundFace Camera…';
    $('summary').textContent += ' · 数字人' + (cloudState.phase === 'live' ? '已开启' : '连接中');
  }
  const testing = video.running && video.inputUID === 'test-pattern' && !audio.privacy;
  if (testing && !localTestSource.running) localTestSource.start(canvas => { void framePump.offer(canvas); });
  else if (!testing && localTestSource.running) { localTestSource.stop(); framePump.reset(); }
  $('test-preview').hidden = !testing;
  if (testing) {
    $('preview-empty').hidden = true; $('ai-label').hidden = true;
    $('preview-badge').textContent = '测试画面'; $('preview-badge').className = 'tag on'; $('preview-label').textContent = '测试画面 · 不开摄像头 · 不扣分钟';
    $('summary').textContent += ' · 测试画面';
  } else if (!active) $('preview-empty').hidden = false;
  $('pip-label').hidden = $('camera-preview').hidden || audio.privacy;
}
async function releaseRtc() {
  outputIntent.cancel(); framePump.reset();
  clearInterval(heartbeatTimer); heartbeatTimer = null;
  if (frameCallback != null) $('cloud-preview').cancelVideoFrameCallback(frameCallback);
  frameCallback = null;
  const engine = rtcEngine; rtcEngine = null;
  // End browser tracks synchronously before awaiting network leave.
  for (const id of ['camera-preview', 'cloud-preview']) {
    const element = $(id); element.srcObject?.getTracks().forEach(track => track.stop()); element.srcObject = null; element.hidden = true;
  }
  $('ai-label').hidden = true; $('preview-empty').hidden = false;
  if (engine) {
    const release = async () => {
      await Promise.allSettled([engine.publishLocalVideoStream(false), engine.enableLocalVideo(false), engine.stopPreview()]);
      await engine.leaveChannel();
    };
    try { await Promise.race([release(), new Promise(resolve => setTimeout(resolve, 2000))]); }
    catch { /* Destroy is required even if publish/leave fails or never settles. */ }
    finally { engine.destroy(); }
  }
}
async function endCloud(reason = 'user_stop') {
  void api.cloudDiagnostic({ stage: 'stop', code: reason });
  ++cloudGeneration;
  const release = releaseRtc();
  const ending = api.stopCloud();
  await release; cloudState = await ending; draw();
}
const ownError = text => Object.assign(new Error(text), { soundface: true });
async function beginCloud({ output = false } = {}) {
  if (!cloudState.configured) throw ownError('服务暂时用不了，请更新到最新版，或联系客服。');
  const generation = ++cloudGeneration;
  connectionEvents = []; void api.cloudDiagnostic({ stage: 'attempt-start', code: rtcTransport });
  if (output) outputIntent.request(); else outputIntent.cancel();
  const check = () => { if (generation !== cloudGeneration || audio.privacy) throw ownError('已取消'); };
  cloudState = { phase: 'creating', billing: 'none', configured: true, error: '', frames: 0 }; draw();
  try {
    if (!stream) await startCamera();
    check();
    const deviceId = stream?.getVideoTracks()[0]?.getSettings().deviceId;
    stopCamera();
    const supported = await AliRtcEngine.isSupported(); check();
    if (!supported.support) throw ownError('这台电脑暂时开不了数字人，请更新到最新版，或联系客服。');
    AliRtcEngine.setLogLevel(AliRtcEngine.AliRtcLogLevel.NONE);
    const engine = rtcEngine = AliRtcEngine.getInstance();
    if (rtcTransport === 'tcp') engine.setParameter(JSON.stringify({ net: { useTCP: true } }));
    engine.setChannelProfile('communication');
    await engine.publishLocalAudioStream(false); check();
    engine.setDefaultSubscribeAllRemoteAudioStreams(false);
    engine.setDefaultSubscribeAllRemoteVideoStreams(true);
    await engine.setCameraCapturerConfiguration({ ...(deviceId ? { deviceId } : {}), width: 1280, height: 720, frameRate: 30 }); check();
    await engine.setLocalViewConfig($('camera-preview'), 1); check();
    await engine.startPreview(); check();
    $('camera-preview').hidden = false;
    const { transport } = await api.startCloud(character).catch(error => { throw ownError(/vidu|上游/i.test(error.message) ? '数字人服务暂时用不了，请过一会儿再试。（错误代码：上游）' : error.message); }); check();
    // Provider-neutral seam: the server names the real-time channel to join.
    if (transport.type !== 'alirtc') throw ownError(`当前版本不支持，请更新到最新版。（错误代码：${String(transport.type).replace(/[^a-z0-9-]/gi, '').slice(0, 20)}）`);
    frameCount = 0; lastFrameAt = 0; awaitingFrameAt = Date.now();
    heartbeatTimer = setInterval(() => {
      const waitingTooLong = !frameCount && Date.now() - awaitingFrameAt > 25000;
      const stalled = frameCount && Date.now() - lastFrameAt > 10000;
      if (waitingTooLong || stalled) { message(waitingTooLong ? '等了 25 秒没有出画面，已自动关闭，没有扣分钟。' : '数字人画面卡住了，已自动关闭。请重新点“开启虚拟摄像头”。'); void endCloud(); return; }
      void api.cloudHeartbeat({ frames: frameCount, width: $('cloud-preview').videoWidth, height: $('cloud-preview').videoHeight }).catch(() => {});
    }, 1000);
    engine.on('videoSubscribeStateChanged', (uid, _old, state) => {
      if (String(uid) !== transport.renderUid || generation !== cloudGeneration) return;
      void api.cloudDiagnostic({ stage: 'render-subscription', code: state });
      if (state !== 3) { framePump.reset(); if (frameCallback != null) $('cloud-preview').cancelVideoFrameCallback(frameCallback); frameCallback = null; $('cloud-preview').hidden = true; $('ai-label').hidden = true; return; }
      const element = $('cloud-preview');
      element.hidden = false;
      engine.setRemoteViewConfig(element, uid, 1);
      const countFrame = () => {
        if (generation !== cloudGeneration) return;
        if (!frameCount && $('message').dataset.kind === 'play-prompt') message('');
        if (!frameCount) void api.cloudDiagnostic({ stage: 'first-frame', code: 'ok' });
        frameCount++; lastFrameAt = Date.now(); element.hidden = false; $('ai-label').hidden = false; $('preview-empty').hidden = true;
        if (outputIntent.requested) void attachGeneratedOutput(generation);
        void framePump.offer(element);
        frameCallback = element.requestVideoFrameCallback(countFrame);
      };
      if (frameCallback != null) element.cancelVideoFrameCallback(frameCallback);
      frameCallback = element.requestVideoFrameCallback(countFrame);
      // The SDK attaches srcObject asynchronously; an early play() can abort
      // while its stream is replaced. Only user-gesture errors need a notice.
      void element.play().catch(error => { if (error.name === 'NotAllowedError') message('点一下预览画面，开始播放。', 'play-prompt'); });
    });
    engine.on('remoteUserOffLineNotify', (uid, reason) => {
      if (String(uid) === transport.renderUid && generation === cloudGeneration) {
        void api.cloudDiagnostic({ stage: 'render-offline', code: reason });
        framePump.reset(); if (frameCallback != null) $('cloud-preview').cancelVideoFrameCallback(frameCallback); frameCallback = null;
        $('cloud-preview').hidden = true; $('ai-label').hidden = true;
        // A renderer may rejoin while warming up. The bounded no-frame watchdog
        // handles failure without tearing down a recoverable subscription.
      }
    });
    engine.on('remoteUserOnLineNotify', uid => { if (String(uid) === transport.renderUid) void api.cloudDiagnostic({ stage: 'render-online', code: 'ok' }); });
    engine.on('connectionStatusChange', (...args) => void api.cloudDiagnostic({ stage: 'rtc-connection', code: args.filter(value => typeof value === 'number').join('-') }));
    engine.on('videoPublishStateChanged', (...args) => void api.cloudDiagnostic({ stage: 'video-publish', code: args.filter(value => typeof value === 'number').join('-') }));
    engine.on('authInfoExpired', () => { if (generation === cloudGeneration) { message('连接过期了，请重新点“开启虚拟摄像头”。'); void endCloud(); } });
    engine.on('bye', code => { if (generation === cloudGeneration) void endCloud('rtc-bye-' + code); });
    await engine.joinChannel(transport.token, transport.userId); check();
    void api.cloudDiagnostic({ stage: 'rtc-joined', code: 'ok' });
    await engine.publishLocalVideoStream(true); check();
  } catch (error) {
    void api.cloudDiagnostic({ stage: 'start-error', code: error.code || error.name || 'unknown' });
    if (generation === cloudGeneration) {
      // Only errors tagged by ownError (incl. main-process IPC errors from startCloud) are shown as-is;
      // raw RTC SDK errors become one plain sentence with the SDK code for support.
      const own = error.soundface === true;
      message(own ? error.message : `数字人连接失败，请检查网络和摄像头权限。（错误代码：${[error.code, error.name].filter(Boolean).join(' · ') || '未知'}）`);
      await endCloud();
    }
  }
}
async function startVirtualCamera() {
  if (vcamOn() || audio.privacy) return;
  if (!cloudState.configured || !cloudState.account) { pendingStart = true; draw(); $('account-button').click(); return; }
  if (cloudState.account.remainingSeconds < 60) { openRecharge('剩余时长不到 1 分钟，请先充值。'); return; }
  if (!cameraAvailable) throw ownError('还没安装虚拟摄像头。请先点“安装虚拟摄像头”。');
  rememberCharacter();
  // One click: start the digital human and send its picture to SoundFace Camera on the first frame.
  await beginCloud({ output: true });
}
async function stopVirtualCamera() {
  confirmingStop = false;
  if (cloudActive() || stopPending()) await endCloud();
  else if (directOutput()) await api.stopVideo();
}
const guarded = action => async () => { try { message(''); await action(); } catch (error) { message(error.message); } finally { draw(); } };
$('cloud-toggle').onclick = guarded(startVirtualCamera);
// Closing needs a second confirmation, except the "再点一次停止" retry.
$('vcam-stop').onclick = () => { if (stopPending()) void guarded(stopVirtualCamera)(); else { confirmingStop = true; draw(); $('vcam-confirm-cancel').focus(); } };
$('vcam-confirm-cancel').onclick = () => { confirmingStop = false; draw(); };
$('vcam-confirm-ok').onclick = guarded(stopVirtualCamera);
$('privacy-big').onclick = () => $('privacy').click();
$('change-character').onclick = () => { $('nav-characters').click(); };
$('test-toggle').onclick = () => run(async () => { if (testRunning()) await api.stopVideo(); else if (!vcamOn()) { video = await api.startVideo('test-pattern'); $('vcam-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } });
// Login from the main button starts right after a successful login; closing the dialog cancels.
const maybeAutoStart = () => { if (pendingStart === 'login' && cloudState.configured && cloudState.account) { pendingStart = false; void guarded(startVirtualCamera)(); } };
document.addEventListener('soundface-login', () => { if (pendingStart) { pendingStart = 'login'; maybeAutoStart(); } });
$('login-dialog').addEventListener('close', () => { if (pendingStart === true) { pendingStart = false; draw(); } });
setInterval(() => { if (vcamOn()) draw(); }, 1000);
$('cloud-preview').onclick = () => { void $('cloud-preview').play().then(() => message('')).catch(() => message('数字人画面暂时放不出来，请重新点“开启虚拟摄像头”。')); };
$('character-grid').onclick = async event => {
  const button = event.target.closest('button'); if (!button || button.disabled || cloudActive()) return;
  if (button.dataset.character) { character = button.dataset.character; rememberCharacter(); draw(); return; }
  if (button.dataset.action === 'import') {
    button.disabled = true;
    try {
      const result = await api.importCharacter();
      if (result) { characters = result.characters; character = result.character.id; rememberCharacter(); characterFilter = 'custom'; renderCharacters(); }
    } catch (error) { message(error.message); }
    finally { draw(); }
  }
};
document.querySelectorAll('[data-character-filter]').forEach(button => { button.onclick = () => { characterFilter = button.dataset.characterFilter; renderCharacters(); draw(); }; });
$('remove-character').onclick = async () => {
  try { characters = await api.removeCharacter(character); character = DEFAULT_CHARACTER; ensureCharacter(); rememberCharacter(); characterFilter = 'all'; renderCharacters(); message('角色已删除，可以在废纸篓里找回。你电脑上的原图没有动。'); }
  catch (error) { message(error.message); }
  draw();
};
api.onCloud(state => {
  cloudState = state;
  if (['stopping', 'ended', 'error'].includes(state.phase)) { ++cloudGeneration; void releaseRtc(); }
  if (state.error) message(state.error);
  draw(); maybeAutoStart();
});
api.onCloudDiagnostic(events => { connectionEvents = events; draw(); });
renderCharacters();
api.cloudState().then(state => { if (!cloudActive()) { cloudState = state; draw(); } }).catch(() => {});
api.listCharacters().then(list => { if (Array.isArray(list) && list.length) { characters = list; if (!cloudActive()) ensureCharacter(); renderCharacters(); draw(); } }).catch(() => {});
api.status().then(status => { cloudState = status.cloud; rtcTransport = status.cloud.transport || 'auto'; connectionEvents = status.cloudDiagnostics || []; characters = status.characters || characters; if ((cloudActive() || stopPending()) && cloudState.characterId && characters.some(item => item.id === cloudState.characterId)) character = cloudState.characterId; else ensureCharacter(); renderCharacters(); draw(); }).catch(error => message(error.message));
let beauty = false;
$('beauty-toggle').onclick = () => {
  beauty = !beauty; $('beauty-toggle').setAttribute('aria-pressed', String(beauty)); $('beauty-toggle').textContent = beauty ? '美颜 · 试用' : '美颜 · 关闭';
  ['smooth', 'tone', 'shape'].forEach(id => { $(id).disabled = !beauty; });
};
['smooth', 'tone', 'shape'].forEach(id => { $(id).oninput = () => { $(id + '-value').textContent = $(id).value; }; });
$('beauty-reset').onclick = () => { for (const [id, value] of Object.entries({ smooth: 30, tone: 20, shape: 0 })) { $(id).value = value; $(id + '-value').textContent = value; } };
window.addEventListener('beforeunload', () => { localTestSource.stop(); ++cloudGeneration; void releaseRtc(); void api.stopCloud(); });
