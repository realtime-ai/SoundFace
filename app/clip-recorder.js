'use strict';
// Records 9:16 short clips (H.264/AAC MP4 via MediaRecorder) from ClipComposer.
// Depends on globals: $, api, audio, video, cloudState, frameCount, lastFrameAt, message.
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
    const useTest = testSelected();
    const source = chooseLiveSource({ privacy: audio.privacy, testMode: useTest, testRunning: testSource.running, cloudPhase: cloudState.phase, cloudFrames: frameCount, lastFrameAt, now: Date.now() });
    lastSource = composer.render(source, source === 'test' ? testCanvas : source === 'cloud' ? $('cloud-preview') : null, $('selected-character-image'), beforeImage).source;
    if (recorder && Date.now() - startedAt >= MAX_MS) void stop();
    if (recorder && audio.privacy) void stop('隐私暂停，录制已停止。');
    drawPanel();
  }
  function startLoop() {
    if (testSelected() && !testSource.running) testSource.start(() => {});
    if (timer == null) timer = setInterval(frame, 1000 / FPS);
    $('clip-preview').hidden = false; frame();
  }
  function stopLoop() {
    clearInterval(timer); timer = null; testSource.stop();
    $('clip-preview').hidden = true;
  }
  async function start() {
    if (!MIME) throw new Error('这台电脑暂时不能录制视频。');
    if (audio.privacy) throw new Error('请先退出隐私暂停。');
    const stream = $('clip-preview').captureStream(FPS);
    if ($('clip-mic').checked) {
      if (!await api.clipMicPermission()) throw new Error('没有麦克风权限。请到“系统设置 → 隐私与安全性 → 麦克风”里允许 SoundFace，或取消勾选“同时录下我的声音”。');
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
    if (!blob.size) { message('没有录到画面，请重新录。'); return; }
    saving = true; drawPanel();
    try {
      const saved = await api.saveClip(new Uint8Array(await blob.arrayBuffer()));
      message((notice ? notice + ' ' : '') + (saved ? '短视频已保存：' + saved : '已取消，这段视频没有保存。'));
    } finally { saving = false; drawPanel(); }
  }
  // Allowed once the virtual camera shows a real picture, or any time with the test picture.
  const testSelected = () => $('clip-test').checked || (video.running && video.inputUID === 'test-pattern');
  const canRecord = () => testSelected() || (cloudState.phase === 'live' && frameCount > 0);
  const mmss = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  function drawPanel() {
    const recording = Boolean(recorder);
    $('clip-toggle-text').textContent = saving ? '正在保存…' : recording ? '停止录制' : '录一段竖屏短视频';
    $('clip-toggle').classList.toggle('recording', recording);
    $('clip-toggle').disabled = saving || (!recording && (audio.privacy || !canRecord()));
    for (const id of ['clip-test', 'clip-mic', 'clip-transition']) $(id).disabled = recording || saving;
    const seconds = recording ? Math.min(60, Math.floor((Date.now() - startedAt) / 1000)) : 0;
    const names = { cloud: '数字人画面', test: '测试画面', placeholder: '“稍后回来”画面' };
    $('clip-badge').hidden = !recording;
    $('clip-badge').textContent = `录制中 ${mmss(seconds)} / 1:00`;
    $('clip-detail').textContent = recording ? `正在录${names[lastSource] || lastSource}，到 1 分钟自动停止` : saving ? '' : audio.privacy ? '隐私暂停中不能录' : canRecord() ? (testSelected() && !(cloudState.phase === 'live' && frameCount > 0) ? '会录测试画面，不扣分钟' : '录成竖屏视频，最长 1 分钟') : '开启虚拟摄像头后可录（测试画面除外）';
  }
  window.clipDraw = drawPanel;
  $('clip-settings-toggle').onclick = () => {
    const open = $('clip-settings').hidden; $('clip-settings').hidden = !open;
    $('clip-settings-toggle').setAttribute('aria-expanded', String(open)); $('clip-settings-toggle').textContent = open ? '设置 ⌃' : '设置 ⌄';
  };
  $('clip-test').addEventListener('change', drawPanel);
  $('clip-toggle').onclick = async () => {
    try { message(''); if (recorder) await stop(); else await start(); }
    catch (error) { micStream?.getTracks().forEach(track => track.stop()); micStream = null; void audioContext?.close(); audioContext = null; recorder = null; stopLoop(); message(error.message); drawPanel(); }
  };
  window.addEventListener('beforeunload', () => { micStream?.getTracks().forEach(track => track.stop()); void audioContext?.close(); stopLoop(); });
  drawPanel();
})();
