'use strict';
// Records 9:16 short clips (H.264/AAC MP4 via MediaRecorder) from ClipComposer.
// Depends on globals: $, api, audio, cloudState, frameCount, lastFrameAt, message.
(() => {
  const MAX_MS = 60000, FPS = 30;
  // Placeholder until the generated-video latency is measured; see DEVELOPMENT.md.
  const CLIP_AUDIO_DELAY_MS = 0;
  const MIME = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'].find(type => window.MediaRecorder && MediaRecorder.isTypeSupported(type));
  const composer = new ClipComposer($('clip-preview'));
  const testCanvas = document.createElement('canvas');
  const testSource = new LocalTestSource(testCanvas, { fps: FPS });
  // Replaceable "before" asset for the compare transition. Missing file → the
  // built-in generic silhouette is drawn instead.
  let beforeImage = null;
  { const image = new Image(); image.onload = () => { beforeImage = image; }; image.src = '../assets/compare-before.png'; }
  let audioContext = null, timer = null, recorder = null, chunks = [], startedAt = 0, micStream = null, saving = false, lastSource = 'placeholder';

  function frame() {
    const useTest = $('clip-test').checked;
    const source = chooseLiveSource({ privacy: audio.privacy, testMode: useTest, testRunning: testSource.running, cloudPhase: cloudState.phase, cloudFrames: frameCount, lastFrameAt, now: Date.now() });
    lastSource = composer.render(source, source === 'test' ? testCanvas : source === 'cloud' ? $('cloud-preview') : null, $('selected-character-image'), beforeImage).source;
    if (recorder && Date.now() - startedAt >= MAX_MS) void stop();
    if (recorder && audio.privacy) void stop('隐私暂停，录制已停止。');
    drawPanel();
  }
  function startLoop() {
    if ($('clip-test').checked && !testSource.running) testSource.start(() => {});
    if (timer == null) timer = setInterval(frame, 1000 / FPS);
    $('clip-preview').hidden = false; frame();
  }
  function stopLoop() {
    clearInterval(timer); timer = null; testSource.stop();
    $('clip-preview').hidden = true;
  }
  async function start() {
    if (!MIME) throw new Error('当前环境不支持录制 MP4。');
    if (audio.privacy) throw new Error('请先退出隐私暂停。');
    const stream = $('clip-preview').captureStream(FPS);
    if ($('clip-mic').checked) {
      if (!await api.clipMicPermission()) throw new Error('麦克风权限未开启，请在系统设置中允许 SoundFace，或取消“录入麦克风声音”。');
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      // Generated video lags the live voice by the cloud round trip. Delay the
      // microphone by the same amount so lips and voice line up in the clip.
      audioContext = new AudioContext();
      const delay = audioContext.createDelay(2); delay.delayTime.value = CLIP_AUDIO_DELAY_MS / 1000;
      const destination = audioContext.createMediaStreamDestination();
      audioContext.createMediaStreamSource(micStream).connect(delay).connect(destination);
      destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    }
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const style = $('clip-transition').value;
    if (style === 'none') composer.skipTransition(); else composer.startTransition(style);
    startedAt = Date.now(); startLoop();
    recorder.start(1000); drawPanel();
  }
  async function stop(notice = '') {
    const active = recorder; if (!active) return;
    recorder = null;
    const stopped = new Promise(resolve => { active.onstop = resolve; });
    if (active.state !== 'inactive') active.stop();
    await stopped;
    micStream?.getTracks().forEach(track => track.stop()); micStream = null; void audioContext?.close(); audioContext = null;
    active.stream.getTracks().forEach(track => track.stop());
    stopLoop(); drawPanel();
    const blob = new Blob(chunks, { type: 'video/mp4' }); chunks = [];
    if (!blob.size) { message('没有录到画面。'); return; }
    saving = true; drawPanel();
    try {
      const saved = await api.saveClip(new Uint8Array(await blob.arrayBuffer()));
      message((notice ? notice + ' ' : '') + (saved ? '片段已保存：' + saved : '已取消保存，片段已丢弃。'));
    } finally { saving = false; drawPanel(); }
  }
  function drawPanel() {
    const recording = Boolean(recorder);
    $('clip-toggle').textContent = saving ? '正在保存…' : recording ? '停止并保存' : '开始录制竖屏片段';
    $('clip-toggle').disabled = saving || (!recording && audio.privacy);
    for (const id of ['clip-test', 'clip-mic', 'clip-transition']) $(id).disabled = recording || saving;
    const seconds = recording ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    const names = { cloud: '数字人画面', test: '本地测试画面', placeholder: '占位画面' };
    $('clip-badge').textContent = recording ? `录制中 ${seconds}s / 60s` : '未录制';
    $('clip-badge').className = 'tag' + (recording ? ' on' : '');
    $('clip-detail').textContent = recording
      ? `当前画面：${names[lastSource] || lastSource}。最长 60 秒，到时自动停止。`
      : '9:16 竖屏 MP4，带 AI 标识和品牌角标。当前云端画面为横屏，居中裁切后约 306×544，放大到 720×1280，画质偏低。';
  }
  $('clip-toggle').onclick = async () => {
    try { message(''); if (recorder) await stop(); else await start(); }
    catch (error) { micStream?.getTracks().forEach(track => track.stop()); micStream = null; void audioContext?.close(); audioContext = null; recorder = null; stopLoop(); message(error.message); drawPanel(); }
  };
  window.addEventListener('beforeunload', () => { micStream?.getTracks().forEach(track => track.stop()); void audioContext?.close(); stopLoop(); });
  drawPanel();
})();
