'use strict';
let cloudState = { phase: 'idle', billing: 'none', configured: false }, character = 'qinghe';
let characters = [{ id: 'qinghe', name: '青禾', thumbnail: '../assets/default-character.jpg', source: 'builtin', description: '自然、清爽的出镜身份，保留你的动作与表情。' }], characterFilter = 'all';
let rtcTransport = 'auto', connectionEvents = [];
let rtcEngine = null, cloudGeneration = 0, heartbeatTimer = null, frameCallback = null, frameCount = 0, lastFrameAt = 0, awaitingFrameAt = 0;
const framePump = new RemoteFramePump({
  route: () => {
    if (!video.running || audio.privacy || !video.frameToken) return null;
    if (video.inputUID === 'test-pattern') return { liveID: video.frameLiveID, frameToken: video.frameToken, kind: 'test' };
    return ['vidu', 'vidu-probe'].includes(video.inputUID) && cloudState.phase === 'live' ? { liveID: cloudState.liveId, frameToken: video.frameToken } : null;
  },
  send: packet => api.videoFrame(packet),
  fail: async error => { await api.stopVideo().catch(() => {}); message('生成帧传输已停止：' + error.message); }
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
    if (generation === cloudGeneration) { message('摄像头输出失败：' + error.message); await endCloud('摄像头输出失败'); }
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
const cloudNames = { idle: '数字人待机', creating: '正在准备数字人…', connecting: '正在连接云端…', waiting_frames: '已连接 · 等待生成画面', live: '实时生成 · AI 合成', stopping: '正在结束云端会话…', ended: '数字人已停止', error: '暂时无法生成' };
function renderCharacters() {
  const grid = $('character-grid'); grid.replaceChildren();
  for (const item of characters.filter(item => characterFilter === 'all' || item.source === characterFilter)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'character-option'; button.dataset.character = item.id;
    const image = document.createElement('img'); image.src = item.thumbnail; image.alt = item.name + '角色参考图';
    const info = document.createElement('span'); info.className = 'character-info';
    const name = document.createElement('strong'); name.textContent = item.name;
    const source = document.createElement('small'); source.textContent = item.source === 'builtin' ? (item.tag || 'SoundFace 默认角色') : '我的参考图';
    const check = document.createElement('span'); check.className = 'selection-check'; check.textContent = '✓';
    info.append(name, source); button.append(image, info, check); grid.append(button);
  }
  const add = document.createElement('button'); add.className = 'add-character'; add.dataset.action = 'import';
  const plus = document.createElement('span'); plus.className = 'import-plus'; plus.textContent = '+';
  const title = document.createElement('strong'); title.textContent = '添加角色';
  const hint = document.createElement('small'); hint.textContent = 'JPG / PNG · 最大 4 MB';
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
    if (outputIntent.active) { $('video-badge').textContent = '等待生成画面'; $('video-detail').textContent = '收到数字人的真实视频帧后，将自动开启摄像头输出。'; }
    else if (cloudState.phase === 'live') $('video-detail').textContent = '当前仅在本机预览，尚未输出。点击“开启虚拟摄像头”后，会议才能收到数字人画面。';
    else $('video-detail').textContent = '尚未输出实时画面。点击“开启数字人并输出”，会议软件中选择 SoundFace Camera。';
  }
  $('video-probe').disabled = busy || audio.privacy || (video.running ? video.inputUID !== 'vidu-probe' : cloudState.phase !== 'live');
  const stats = framePump.stats;
  $('frame-metrics').textContent = stats.forwarded ? `本次运行累计传递 ${stats.forwarded} 帧 · 当前/最近一轮原生转换 ${video.converted || 0} 帧 · 平均读帧/编码 ${stats.encodeMs.toFixed(1)} ms · IPC/原生处理 ${stats.bridgeMs.toFixed(1)} ms（非端到端延迟）` : '尚未向虚拟摄像头提交生成帧。开启数字人并输出后，这里会显示实际转发计数。';
  $('cloud-toggle').textContent = cloudState.billing === 'unknown' ? '重试结束云端' : active ? '停止数字人' : wantsGeneratedOutput() ? '开启数字人并输出' : '开启数字人预览';
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
  $('session-limit').textContent = account ? `账号 ${account.name} · 剩余 ${Math.floor(account.remainingSeconds / 60)} 分 ${account.remainingSeconds % 60} 秒 · 按实际生成时长扣除` : '手动结束 · 按实际生成时长计费';
  $('cloud-status').textContent = !cloudState.configured ? '尚未登录 SoundFace 账号，暂不能开启数字人。' : (cloudState.phase === 'ended' && !cloudState.frames ? (cloudState.closeReason === 'live_ended' ? '生成连接中断 · 未收到画面' : '已停止 · 尚未收到生成画面') : cloudNames[cloudState.phase] || cloudState.phase) + (cloudState.billing === 'ended' ? ' · 云端结束已确认' : cloudState.billing === 'unknown' ? ' · 云端结束未确认' : '');
  if (cloudState.frames > 0 || cloudState.billing === 'ended') {
    const elapsed = cloudState.startedAt ? Math.max(0, (Date.now() - cloudState.startedAt) / 1000).toFixed(0) : 0;
    $('cloud-metrics').textContent = `${cloudState.frames > 0 ? `${cloudState.width} × ${cloudState.height} · 已显示 ${cloudState.frames} 帧 · 首帧 ${(cloudState.firstFrameMs / 1000).toFixed(1)} 秒` : '尚未收到生成帧'}${active ? ` · 已运行 ${elapsed} 秒` : ''}${cloudState.billedSeconds != null ? ` · 账单 ${cloudState.billedSeconds} 秒 / ${cloudState.creditsCost} 积分` : ''}`;
  } else $('cloud-metrics').textContent = active ? '画面正在发送至云端生成服务；点击“停止数字人”结束计费。' : '开启后上传所选参考图与镜头画面，按实际用量计费。';
  $('cloud-metrics').hidden = !active && !(cloudState.frames > 0 || cloudState.billing === 'ended');
  $('camera-toggle').disabled = active || audio.privacy;
  $('camera-input').disabled = active || Boolean(stream) || audio.privacy;
  $('preview-empty').querySelector('strong').textContent = active ? '正在准备你的另一面' : '让另一个你，走到镜头前';
  $('preview-empty').querySelector('p').textContent = active ? '真实镜头显示在右下角，生成结果将显示在这里' : '先选择角色，再开启数字人';
  $('preview-empty').querySelector('span').textContent = active ? '正在连接 · 仅发送摄像头视频' : '待机中 · 摄像头未采集';
  if (active) {
    $('preview-badge').textContent = cloudState.phase === 'live' ? '实时生成' : '云端验证';
    $('preview-label').textContent = video.running && video.inputUID === 'vidu' ? 'AI 合成 · 正在提交虚拟摄像头' : 'AI 合成 · 本地回显';
    $('summary').textContent += ' · 数字人' + (cloudState.phase === 'live' ? '实时生成' : '连接中');
  }
  const testing = video.running && video.inputUID === 'test-pattern' && !audio.privacy;
  if (testing && !localTestSource.running) localTestSource.start(canvas => { void framePump.offer(canvas); });
  else if (!testing && localTestSource.running) { localTestSource.stop(); framePump.reset(); }
  $('test-preview').hidden = !testing;
  if (testing) {
    $('preview-empty').hidden = true; $('ai-label').hidden = true;
    $('preview-badge').textContent = '本地测试'; $('preview-label').textContent = '本地模拟 · 无摄像头采集 · 无云端费用';
    $('summary').textContent += ' · 本地动态测试';
  } else if (!stream && !active) $('preview-empty').hidden = false;
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
  $('camera-preview').classList.remove('source-inset'); $('ai-label').hidden = true; $('preview-empty').hidden = false;
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
async function beginCloud({ output = false } = {}) {
  if (!cloudState.configured) throw new Error('云端服务暂不可用，请更新应用或联系支持。');
  const generation = ++cloudGeneration;
  connectionEvents = []; void api.cloudDiagnostic({ stage: 'attempt-start', code: rtcTransport });
  if (output) outputIntent.request(); else outputIntent.cancel();
  const check = () => { if (generation !== cloudGeneration || audio.privacy) throw new Error('验证已取消'); };
  cloudState = { phase: 'creating', billing: 'none', configured: true, error: '', frames: 0 }; draw();
  try {
    if (!stream) await startCamera();
    check();
    const deviceId = stream?.getVideoTracks()[0]?.getSettings().deviceId;
    stopCamera();
    const supported = await AliRtcEngine.isSupported(); check();
    if (!supported.support) throw new Error('当前 Electron 环境不支持阿里云 RTC');
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
    $('camera-preview').classList.add('source-inset'); $('camera-preview').hidden = false;
    const { transport } = await api.startCloud(character); check();
    // Provider-neutral seam: the server names the real-time channel to join.
    if (transport.type !== 'alirtc') throw new Error(`当前版本暂不支持该实时通道（${String(transport.type).replace(/[^a-z0-9-]/gi, '').slice(0, 20)}）`);
    frameCount = 0; lastFrameAt = 0; awaitingFrameAt = Date.now();
    heartbeatTimer = setInterval(() => {
      const waitingTooLong = !frameCount && Date.now() - awaitingFrameAt > 25000;
      const stalled = frameCount && Date.now() - lastFrameAt > 10000;
      if (waitingTooLong || stalled) { message(waitingTooLong ? '25 秒内未收到云端帧，已停止会话。' : '云端视频已停滞，已停止会话。'); void endCloud(); return; }
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
        if (!frameCount && $('message').textContent === '请点击预览区域播放生成视频') message('');
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
      void element.play().catch(error => { if (error.name === 'NotAllowedError') message('请点击预览区域播放生成视频'); });
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
    engine.on('authInfoExpired', () => { if (generation === cloudGeneration) { message('云端凭证已过期'); void endCloud(); } });
    engine.on('bye', code => { if (generation === cloudGeneration) void endCloud('rtc-bye-' + code); });
    await engine.joinChannel(transport.token, transport.userId); check();
    void api.cloudDiagnostic({ stage: 'rtc-joined', code: 'ok' });
    await engine.publishLocalVideoStream(true); check();
  } catch (error) {
    void api.cloudDiagnostic({ stage: 'start-error', code: error.code || error.name || 'unknown' });
    if (generation === cloudGeneration) {
      message(error.message?.startsWith('Vidu') || error.message?.startsWith('当前版本暂不支持') || /登录|剩余时长|尚未结束|服务/.test(error.message || '') || ['验证已取消', '当前 Electron 环境不支持阿里云 RTC'].includes(error.message) ? error.message : `视频连接失败${error.code ? ' · ' + error.code : ''}：${error.name || '请检查网络及摄像头权限'}`);
      await endCloud();
    }
  }
}
$('cloud-toggle').onclick = async () => {
  try { message(''); if (cloudActive() || cloudState.billing === 'unknown') await endCloud(); else await beginCloud({ output: wantsGeneratedOutput() }); }
  catch (error) { message(error.message); } finally { draw(); }
};
$('cloud-preview').onclick = () => { void $('cloud-preview').play().then(() => message('')).catch(() => message('生成视频暂时无法播放')); };
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
  try { characters = await api.removeCharacter(character); character = 'qinghe'; characterFilter = 'all'; renderCharacters(); message('角色已移至废纸篓，原始图片保留在原位置。'); }
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
  beauty = !beauty; $('beauty-toggle').setAttribute('aria-pressed', String(beauty)); $('beauty-toggle').textContent = beauty ? '美颜 · 参数预览' : '美颜 · 关闭';
  ['smooth', 'tone', 'shape'].forEach(id => { $(id).disabled = !beauty; });
};
['smooth', 'tone', 'shape'].forEach(id => { $(id).oninput = () => { $(id + '-value').textContent = $(id).value; }; });
$('beauty-reset').onclick = () => { for (const [id, value] of Object.entries({ smooth: 30, tone: 20, shape: 0 })) { $(id).value = value; $(id + '-value').textContent = value; } };
window.addEventListener('beforeunload', () => { localTestSource.stop(); ++cloudGeneration; void releaseRtc(); void api.stopCloud(); });
