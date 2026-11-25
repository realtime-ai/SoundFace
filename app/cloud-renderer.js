'use strict';
let cloudState = { phase: 'idle', billing: 'none', configured: false }, character = 'qinghe';
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
const wantsGeneratedOutput = () => cameraAvailable && $('video-input').value === 'vidu';
const frameMetrics = () => ({ frames: frameCount, width: $('cloud-preview').videoWidth, height: $('cloud-preview').videoHeight });
async function attachGeneratedOutput(generation) {
  try {
    const state = await outputIntent.onFrame(() => api.cloudHeartbeat(frameMetrics()));
    if (state && generation === cloudGeneration) video = state;
  } catch (error) {
    if (generation === cloudGeneration) { message('虚拟摄像头开启失败：' + error.message); await endCloud('摄像头输出失败'); }
  } finally { draw(); }
}
async function startGeneratedOutput() {
  if (cloudState.phase === 'live') { outputIntent.request(); draw(); await attachGeneratedOutput(cloudGeneration); }
  else if (!cloudActive()) await beginCloud({ output: true });
}
document.addEventListener('securitypolicyviolation', event => {
  let origin = ''; try { origin = new URL(event.blockedURI).origin; } catch { origin = 'non-url'; }
  void api.cloudDiagnostic({ stage: 'csp-' + event.effectiveDirective, code: origin });
});
const cloudActive = () => ['creating', 'connecting', 'waiting_frames', 'live', 'stopping'].includes(cloudState.phase);
const cloudNames = { idle: '数字人未开启', creating: '正在准备数字人…', connecting: '正在连接…', waiting_frames: '已连接，等待数字人画面出现', live: '数字人已开启', stopping: '正在停止…', ended: '数字人已停止', error: '数字人暂时开不了' };
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
  if (!video.running && $('video-input').value === 'vidu') {
    $('video-toggle').disabled = busy || audio.privacy || !cameraAvailable || outputIntent.active || !cloudState.configured || cloudState.billing === 'unknown' || (active && cloudState.phase !== 'live');
    $('video-toggle').textContent = outputIntent.active ? '正在准备输出…' : cloudState.phase === 'live' ? '开启虚拟摄像头' : '开启数字人并输出';
    if (outputIntent.active) { $('video-badge').textContent = '等待数字人画面'; $('video-detail').textContent = '数字人画面出现后，会自动送到虚拟摄像头。'; }
    else if (cloudState.phase === 'live') $('video-detail').textContent = '现在只有你自己能看到。点“开启虚拟摄像头”后，直播软件才能收到数字人画面。';
    else $('video-detail').textContent = '还没有画面。点“开启数字人”，再到直播软件的摄像头列表里选 SoundFace Camera。';
  }
  $('video-probe').disabled = busy || audio.privacy || (video.running ? video.inputUID !== 'vidu-probe' : cloudState.phase !== 'live');
  const stats = framePump.stats;
  $('frame-metrics').textContent = stats.forwarded ? `本次运行累计传递 ${stats.forwarded} 帧 · 当前/最近一轮原生转换 ${video.converted || 0} 帧 · 平均读帧/编码 ${stats.encodeMs.toFixed(1)} ms · IPC/原生处理 ${stats.bridgeMs.toFixed(1)} ms（非端到端延迟）` : '尚未向虚拟摄像头提交生成帧。开启数字人并输出后，这里会显示实际转发计数。';
  $('cloud-toggle').textContent = cloudState.billing === 'unknown' ? '再点一次停止' : active ? '停止数字人' : wantsGeneratedOutput() ? '开启数字人并输出' : '开启数字人预览';
  $('cloud-toggle').disabled = cloudState.phase === 'stopping' || audio.privacy || (!active && cloudState.billing !== 'unknown' && (!cloudState.configured || !characters.some(item => item.id === character)));
  document.querySelectorAll('[data-character]').forEach(button => {
    button.classList.toggle('selected', button.dataset.character === character);
    button.setAttribute('aria-pressed', String(button.dataset.character === character));
    button.disabled = active;
  });
  const selected = characters.find(item => item.id === character) || characters[0];
  $('selected-character').textContent = selected.name;
  $('character-description').textContent = selected.description;
  for (const id of ['selected-character-image', 'idle-character-image']) if ($(id).getAttribute('src') !== selected.thumbnail) $(id).src = selected.thumbnail;
  $('remove-character').hidden = selected.source !== 'custom'; $('remove-character').disabled = active || cloudState.billing === 'unknown';
  document.querySelector('[data-action="import"]').disabled = active || cloudState.billing === 'unknown';
  const account = cloudState.account;
  $('session-limit').textContent = account ? `${account.name} · 剩余 ${Math.floor(account.remainingSeconds / 60)} 分钟` : '登录后可查看剩余时长';
  $('recharge-open').hidden = !account;
  $('cloud-status').textContent = !cloudState.configured ? '请先登录，再开启数字人。' : (cloudState.phase === 'ended' && !cloudState.frames ? (cloudState.closeReason === 'live_ended' ? '连接断了，没有出画面' : '已停止，没有出画面') : cloudNames[cloudState.phase] || cloudState.phase) + (cloudState.billing === 'unknown' ? ' · 还没完全停止，请再点一次停止' : '');
  // Main panel: plain time only. Resolution, frame counts and timings go to the support area.
  if (active && cloudState.frames > 0) {
    const firstFrameAt = cloudState.startedAt ? cloudState.startedAt + (cloudState.firstFrameMs || 0) : Date.now();
    $('cloud-metrics').textContent = `已开启 ${clock((Date.now() - firstFrameAt) / 1000)}`;
  } else if (active) $('cloud-metrics').textContent = '正在使用中，会扣分钟。点“停止数字人”后不再扣。';
  else if (cloudState.billing === 'ended') $('cloud-metrics').textContent = cloudState.frames > 0 ? (cloudState.billedSeconds != null ? `本次用了 ${clock(cloudState.billedSeconds)}` : '') : '没出画面，没有扣分钟。';
  else $('cloud-metrics').textContent = '开启后会上传角色照片和摄像头画面，按使用时长扣分钟。';
  $('cloud-metrics').hidden = !active && cloudState.billing !== 'ended';
  if (cloudState.frames > 0 || cloudState.billing === 'ended') {
    const elapsed = cloudState.startedAt ? Math.max(0, (Date.now() - cloudState.startedAt) / 1000).toFixed(0) : 0;
    $('cloud-diagnostic').textContent = `${cloudState.frames > 0 ? `${cloudState.width} × ${cloudState.height} · 已显示 ${cloudState.frames} 帧 · 首帧 ${(cloudState.firstFrameMs / 1000).toFixed(1)} 秒` : '尚未收到生成帧'}${active ? ` · 已运行 ${elapsed} 秒` : ''}${cloudState.billedSeconds != null ? ` · 账单 ${cloudState.billedSeconds} 秒 / ${cloudState.creditsCost} 积分` : ''}`;
  } else $('cloud-diagnostic').textContent = '';
  $('camera-toggle').disabled = active || audio.privacy;
  $('camera-input').disabled = active || Boolean(stream) || audio.privacy;
  $('preview-empty').querySelector('strong').textContent = active ? '正在准备数字人，请稍等几秒' : '让另一个你，走到镜头前';
  $('preview-empty').querySelector('p').textContent = active ? '你的真实画面只在右下角小窗里，数字人画面显示在这里' : '选一个角色，点“开启数字人”';
  $('preview-empty').querySelector('span').textContent = active ? '正在连接，只上传摄像头画面，不上传声音' : stream ? '摄像头已开启，小窗只有你自己能看到' : '摄像头未开启';
  if (active) {
    $('preview-badge').textContent = cloudState.phase === 'live' ? '数字人已开启' : '检查中';
    $('preview-label').textContent = video.running && video.inputUID === 'vidu' ? 'AI 合成 · 已送到虚拟摄像头' : 'AI 合成 · 仅预览';
    $('summary').textContent += ' · 数字人' + (cloudState.phase === 'live' ? '已开启' : '连接中');
  }
  const testing = video.running && video.inputUID === 'test-pattern' && !audio.privacy;
  if (testing && !localTestSource.running) localTestSource.start(canvas => { void framePump.offer(canvas); });
  else if (!testing && localTestSource.running) { localTestSource.stop(); framePump.reset(); }
  $('test-preview').hidden = !testing;
  if (testing) {
    $('preview-empty').hidden = true; $('ai-label').hidden = true;
    $('preview-badge').textContent = '测试画面'; $('preview-label').textContent = '测试画面 · 不开摄像头 · 不扣分钟';
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
      if (waitingTooLong || stalled) { message(waitingTooLong ? '等了 25 秒没有出画面，已自动停止，没有扣分钟。' : '数字人画面卡住了，已自动停止。请重新开启。'); void endCloud(); return; }
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
    engine.on('authInfoExpired', () => { if (generation === cloudGeneration) { message('连接过期了，请重新开启数字人。'); void endCloud(); } });
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
$('cloud-toggle').onclick = async () => {
  if (!cloudActive() && cloudState.billing !== 'unknown' && cloudState.account && cloudState.account.remainingSeconds < 60) { openRecharge('剩余时长不到 1 分钟，请先充值。'); return; }
  try { message(''); if (cloudActive() || cloudState.billing === 'unknown') await endCloud(); else await beginCloud({ output: wantsGeneratedOutput() }); }
  catch (error) { message(error.message); } finally { draw(); }
};
$('cloud-preview').onclick = () => { void $('cloud-preview').play().then(() => message('')).catch(() => message('数字人画面暂时放不出来，请重新开启。')); };
$('character-grid').onclick = async event => {
  const button = event.target.closest('button'); if (!button || button.disabled || cloudActive()) return;
  if (button.dataset.character) { character = button.dataset.character; draw(); return; }
  if (button.dataset.action === 'import') {
    button.disabled = true;
    try {
      const result = await api.importCharacter();
      if (result) { characters = result.characters; character = result.character.id; characterFilter = 'custom'; renderCharacters(); }
    } catch (error) { message(error.message); }
    finally { draw(); }
  }
};
document.querySelectorAll('[data-character-filter]').forEach(button => { button.onclick = () => { characterFilter = button.dataset.characterFilter; renderCharacters(); draw(); }; });
$('remove-character').onclick = async () => {
  try { characters = await api.removeCharacter(character); character = 'qinghe'; characterFilter = 'all'; renderCharacters(); message('角色已删除，可以在废纸篓里找回。你电脑上的原图没有动。'); }
  catch (error) { message(error.message); }
  draw();
};
api.onCloud(state => {
  cloudState = state;
  if (['stopping', 'ended', 'error'].includes(state.phase)) { ++cloudGeneration; void releaseRtc(); }
  if (state.error) message(state.error);
  draw();
});
api.onCloudDiagnostic(events => { connectionEvents = events; draw(); });
renderCharacters();
api.cloudState().then(state => { if (!cloudActive()) { cloudState = state; draw(); } }).catch(() => {});
api.listCharacters().then(list => { if (Array.isArray(list) && list.length) { characters = list; renderCharacters(); draw(); } }).catch(() => {});
api.status().then(status => { cloudState = status.cloud; rtcTransport = status.cloud.transport || 'auto'; connectionEvents = status.cloudDiagnostics || []; characters = status.characters || characters; if (cloudState.characterId && characters.some(item => item.id === cloudState.characterId)) character = cloudState.characterId; renderCharacters(); draw(); }).catch(error => message(error.message));
let beauty = false;
$('beauty-toggle').onclick = () => {
  beauty = !beauty; $('beauty-toggle').setAttribute('aria-pressed', String(beauty)); $('beauty-toggle').textContent = beauty ? '美颜 · 试用' : '美颜 · 关闭';
  ['smooth', 'tone', 'shape'].forEach(id => { $(id).disabled = !beauty; });
};
['smooth', 'tone', 'shape'].forEach(id => { $(id).oninput = () => { $(id + '-value').textContent = $(id).value; }; });
$('beauty-reset').onclick = () => { for (const [id, value] of Object.entries({ smooth: 30, tone: 20, shape: 0 })) { $(id).value = value; $(id + '-value').textContent = value; } };
window.addEventListener('beforeunload', () => { localTestSource.stop(); ++cloudGeneration; void releaseRtc(); void api.stopCloud(); });
