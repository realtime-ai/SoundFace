'use strict';
// Opens the standalone "SoundFace 直播画面" window for OBS window capture.
// The child is a same-origin about:blank popup; this renderer owns its canvas
// and drives it from the child's animation frames. Depends on globals from
// renderer.js / cloud-renderer.js: $, audio, cloudState, frameCount, lastFrameAt, message.
(() => {
  const NAME = 'soundface-live';
  let child = null, compositor = null, raf = null, testMode = false, lastBadgeAt = 0, lastRenderAt = 0;
  const FRAME_MS = 1000 / 30; // Cap at 30 fps: displays may run at 120 Hz.
  const testCanvas = document.createElement('canvas');
  const testSource = new LocalTestSource(testCanvas, { fps: 30 });
  const isOpen = () => Boolean(child && !child.closed);

  function setup(win) {
    const doc = win.document;
    doc.title = 'SoundFace 直播画面';
    for (const node of [doc.documentElement, doc.body]) {
      node.style.margin = '0'; node.style.height = '100%'; node.style.background = '#000'; node.style.overflow = 'hidden';
    }
    // Frameless window: the whole surface drags it; OBS captures the content.
    doc.body.style.setProperty('-webkit-app-region', 'drag'); doc.body.style.cursor = 'default';
    const canvas = doc.createElement('canvas');
    canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.display = 'block'; canvas.style.objectFit = 'contain';
    doc.body.replaceChildren(canvas);
    compositor = new LiveCompositor(canvas);
    win.addEventListener('pagehide', close);
  }
  function tick() {
    raf = null;
    if (!isOpen()) { close(); return; }
    raf = child.requestAnimationFrame(tick);
    const now = performance.now();
    if (now - lastRenderAt < FRAME_MS - 2) return;
    lastRenderAt = now;
    const source = chooseLiveSource({
      privacy: audio.privacy, testMode, testRunning: testSource.running,
      cloudPhase: cloudState.phase, cloudFrames: frameCount, lastFrameAt, now: Date.now()
    });
    compositor.render(source, source === 'test' ? testCanvas : source === 'cloud' ? $('cloud-preview') : null);
    if (Date.now() - lastBadgeAt > 500) { lastBadgeAt = Date.now(); drawPanel(); }
  }
  function syncTestSource() {
    const wanted = isOpen() && testMode && !audio.privacy;
    if (wanted && !testSource.running) testSource.start(() => {});
    else if (!wanted && testSource.running) testSource.stop();
  }
  function open() {
    if (isOpen()) { child.focus(); return; }
    const win = window.open('about:blank', NAME);
    if (!win) throw new Error('无法打开直播画面窗口。');
    child = win; setup(win); syncTestSource();
    raf = win.requestAnimationFrame(tick); drawPanel();
  }
  function close() {
    const win = child; child = null; compositor = null;
    if (win && raf != null) { try { win.cancelAnimationFrame(raf); } catch { /* Window already gone. */ } }
    raf = null;
    if (win && !win.closed) win.close();
    syncTestSource(); drawPanel();
  }
  const sourceNames = { cloud: '数字人画面', test: '本地测试画面', placeholder: '占位画面', privacy: '隐私占位' };
  function drawPanel() {
    const open = isOpen();
    $('live-toggle').textContent = open ? '关闭直播画面窗口' : '打开直播画面窗口';
    $('live-test').checked = testMode;
    const stats = compositor?.stats;
    $('live-badge').textContent = open ? `${sourceNames[stats?.source] || '准备中'} · ${stats?.fps || 0} fps` : '未打开';
    $('live-badge').className = 'tag' + (open && (stats?.source === 'cloud' || stats?.source === 'test') ? ' on' : '');
    $('live-detail').textContent = open
      ? 'OBS：来源 → 添加“macOS 屏幕采集”（或“窗口采集”）→ 选择窗口“SoundFace 直播画面”。没有生成画面时显示“稍后回来”，不会出现摄像头原始画面。'
      : '独立窗口输出 1280 × 720 画面，供 OBS 等直播软件用窗口采集抓取。';
  }
  $('live-toggle').onclick = () => { try { if (isOpen()) close(); else open(); } catch (error) { message(error.message); } };
  $('live-test').onchange = () => { testMode = $('live-test').checked; syncTestSource(); drawPanel(); };
  api.onAudio(() => syncTestSource());
  window.addEventListener('beforeunload', close);
  drawPanel();
})();
