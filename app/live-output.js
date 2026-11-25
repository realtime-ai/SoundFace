'use strict';
// Composites the "live window" that OBS captures with window capture.
// Inputs are limited to the generated <video> element and the local synthetic
// canvas. The physical camera preview is never an input: when no generated
// frame is fresh, a neutral slate is drawn instead.
const LIVE_WIDTH = 1280, LIVE_HEIGHT = 720, LIVE_STALE_MS = 250;

function chooseLiveSource({ privacy, testMode, testRunning, cloudPhase, cloudFrames, lastFrameAt, now }) {
  if (privacy) return 'privacy';
  if (testMode) return testRunning ? 'test' : 'placeholder';
  if (cloudPhase === 'live' && cloudFrames > 0 && Number.isFinite(lastFrameAt) && now - lastFrameAt <= LIVE_STALE_MS) return 'cloud';
  return 'placeholder';
}

class LiveCompositor {
  constructor(canvas, { now = Date.now } = {}) {
    this.canvas = canvas; this.now = now;
    canvas.width = LIVE_WIDTH; canvas.height = LIVE_HEIGHT;
    this.context = canvas.getContext('2d', { alpha: false });
    this.stats = { frames: 0, fps: 0, source: 'placeholder' };
    this.windowStart = null; this.windowFrames = 0;
  }
  render(source, element) {
    const ctx = this.context;
    const width = element ? element.videoWidth || element.width || 0 : 0, height = element ? element.videoHeight || element.height || 0 : 0;
    const drawable = (source === 'cloud' || source === 'test') && width > 0 && height > 0;
    const shown = drawable ? source : source === 'privacy' ? 'privacy' : 'placeholder';
    ctx.fillStyle = '#080c18'; ctx.fillRect(0, 0, LIVE_WIDTH, LIVE_HEIGHT);
    if (drawable) {
      const scale = Math.min(LIVE_WIDTH / width, LIVE_HEIGHT / height), w = width * scale, h = height * scale;
      ctx.drawImage(element, (LIVE_WIDTH - w) / 2, (LIVE_HEIGHT - h) / 2, w, h);
      // Burned into pixels so every downstream app keeps the synthesis label.
      ctx.fillStyle = 'rgba(43, 63, 181, 0.85)'; ctx.fillRect(LIVE_WIDTH - 318, 24, 294, 44);
      ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(shown === 'test' ? '测试画面 · SoundFace' : 'AI 合成 · SoundFace', LIVE_WIDTH - 304, 53);
    } else {
      ctx.fillStyle = '#4c6fff'; ctx.fillRect(LIVE_WIDTH / 2 - 36, LIVE_HEIGHT / 2 - 92, 72, 6);
      ctx.fillStyle = '#ffffff'; ctx.font = '600 44px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('稍后回来', LIVE_WIDTH / 2, LIVE_HEIGHT / 2);
      ctx.fillStyle = '#c3cde8'; ctx.font = '24px sans-serif';
      ctx.fillText('主播马上回来 · SoundFace', LIVE_WIDTH / 2, LIVE_HEIGHT / 2 + 48);
      ctx.textAlign = 'left';
    }
    const now = this.now();
    if (this.windowStart == null) this.windowStart = now;
    this.stats.frames++; this.windowFrames++; this.stats.source = shown;
    if (now - this.windowStart >= 1000) {
      this.stats.fps = Math.round(this.windowFrames * 1000 / (now - this.windowStart));
      this.windowStart = now; this.windowFrames = 0;
    }
    return shown;
  }
}

if (typeof module !== 'undefined') module.exports = { chooseLiveSource, LiveCompositor, LIVE_WIDTH, LIVE_HEIGHT, LIVE_STALE_MS };
