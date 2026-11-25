'use strict';
// Composes 9:16 short-video frames. Inputs: the generated <video> or local test
// canvas (center-cropped), and the AI character's reference image, shown only
// heavily blurred and darkened during the opening transition. Never the real
// camera. (A true silhouette would need segmentation; JPG references have no alpha.)
const CLIP_WIDTH = 720, CLIP_HEIGHT = 1280, CLIP_TRANSITION_MS = 1600, CLIP_COMPARE_MS = 2600;

function cropToPortrait(width, height, ratio = 9 / 16) {
  if (!(width > 0 && height > 0)) return null;
  if (width / height > ratio) { const sw = height * ratio; return { sx: (width - sw) / 2, sy: 0, sw, sh: height }; }
  const sh = width / ratio; return { sx: 0, sy: (height - sh) / 2, sw: width, sh };
}

// 0–35%: blurred character teaser only; 35–100%: teaser fades out while the generated
// picture fades in from heavy blur to sharp.
function transitionAt(elapsed, duration = CLIP_TRANSITION_MS) {
  const t = Math.min(1, Math.max(0, elapsed / duration));
  if (t >= 1) return { silhouette: 0, source: 1, blur: 0, done: true };
  const reveal = Math.max(0, (t - 0.35) / 0.65);
  return { silhouette: 1 - reveal, source: reveal, blur: Math.round(24 * (1 - reveal)), done: false };
}

// "Before / after": 0–45% shows a generic silhouette (never the user), then a
// left-to-right wipe reveals the generated picture.
function compareAt(elapsed, duration = CLIP_COMPARE_MS) {
  const t = Math.min(1, Math.max(0, elapsed / duration));
  if (t >= 1) return { wipe: 1, done: true };
  return { wipe: Math.max(0, (t - 0.45) / 0.55), done: false };
}

// Default "before" asset: a generic head-and-shoulders shape, unrelated to the
// user. A replacement image can be passed as `beforeImage`.
function drawGenericSilhouette(ctx, width, height) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#1a2a5e'); gradient.addColorStop(1, '#080c18');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#05080a';
  ctx.beginPath(); ctx.ellipse(width / 2, height * 0.38, width * 0.17, height * 0.12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(width * 0.12, height); ctx.quadraticCurveTo(width * 0.14, height * 0.58, width / 2, height * 0.55);
  ctx.quadraticCurveTo(width * 0.86, height * 0.58, width * 0.88, height); ctx.closePath(); ctx.fill();
}

class ClipComposer {
  constructor(canvas, { now = Date.now } = {}) {
    this.canvas = canvas; this.now = now;
    canvas.width = CLIP_WIDTH; canvas.height = CLIP_HEIGHT;
    this.context = canvas.getContext('2d', { alpha: false });
    this.transitionStart = null; this.style = 'blur';
  }
  startTransition(style = 'blur') { this.transitionStart = this.now(); this.style = style === 'compare' ? 'compare' : 'blur'; }
  skipTransition() { this.transitionStart = null; }
  render(source, element, silhouetteImage, beforeImage = null) {
    if (this.transitionStart != null && this.style === 'compare') return this.renderCompare(source, element, beforeImage);
    const ctx = this.context;
    ctx.save();
    ctx.fillStyle = '#080c18'; ctx.fillRect(0, 0, CLIP_WIDTH, CLIP_HEIGHT);
    const phase = this.transitionStart == null ? transitionAt(Infinity) : transitionAt(this.now() - this.transitionStart);
    if (phase.done) this.transitionStart = null;
    const live = (source === 'cloud' || source === 'test') && element;
    const crop = live ? cropToPortrait(element.videoWidth || element.width, element.videoHeight || element.height) : null;
    if (phase.silhouette > 0 && silhouetteImage && (silhouetteImage.naturalWidth || silhouetteImage.width)) {
      const box = cropToPortrait(silhouetteImage.naturalWidth || silhouetteImage.width, silhouetteImage.naturalHeight || silhouetteImage.height);
      ctx.globalAlpha = phase.silhouette; ctx.filter = 'blur(28px) brightness(0.5)';
      ctx.drawImage(silhouetteImage, box.sx, box.sy, box.sw, box.sh, 0, 0, CLIP_WIDTH, CLIP_HEIGHT);
      ctx.filter = 'none'; ctx.globalAlpha = 1;
    }
    if (crop && phase.source > 0) {
      ctx.globalAlpha = phase.source; ctx.filter = phase.blur ? `blur(${phase.blur}px)` : 'none';
      ctx.drawImage(element, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, CLIP_WIDTH, CLIP_HEIGHT);
      ctx.filter = 'none'; ctx.globalAlpha = 1;
    } else if (!crop && phase.silhouette === 0) {
      ctx.fillStyle = '#ffffff'; ctx.font = '600 52px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('稍后回来', CLIP_WIDTH / 2, CLIP_HEIGHT / 2);
      ctx.textAlign = 'left';
    }
    this.drawMarks(source);
    ctx.restore();
    return { source: crop ? source : 'placeholder', transition: !phase.done };
  }
  renderCompare(source, element, beforeImage) {
    const ctx = this.context;
    ctx.save();
    const phase = compareAt(this.now() - this.transitionStart);
    if (phase.done) this.transitionStart = null;
    const live = (source === 'cloud' || source === 'test') && element;
    const crop = live ? cropToPortrait(element.videoWidth || element.width, element.videoHeight || element.height) : null;
    const split = Math.round(CLIP_WIDTH * phase.wipe);
    if (beforeImage && (beforeImage.naturalWidth || beforeImage.width)) {
      const box = cropToPortrait(beforeImage.naturalWidth || beforeImage.width, beforeImage.naturalHeight || beforeImage.height);
      ctx.drawImage(beforeImage, box.sx, box.sy, box.sw, box.sh, 0, 0, CLIP_WIDTH, CLIP_HEIGHT);
    } else drawGenericSilhouette(ctx, CLIP_WIDTH, CLIP_HEIGHT);
    if (split > 0) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, split, CLIP_HEIGHT); ctx.clip();
      ctx.fillStyle = '#080c18'; ctx.fillRect(0, 0, CLIP_WIDTH, CLIP_HEIGHT);
      if (crop) ctx.drawImage(element, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, CLIP_WIDTH, CLIP_HEIGHT);
      ctx.restore();
      ctx.fillStyle = '#4c6fff'; ctx.fillRect(split - 3, 0, 6, CLIP_HEIGHT);
    }
    ctx.font = '600 36px sans-serif'; ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    if (split < CLIP_WIDTH - 140) { ctx.textAlign = 'right'; ctx.fillText('变身前', CLIP_WIDTH - 32, 140); }
    if (split > 140) { ctx.textAlign = 'left'; ctx.fillText('变身后', 32, 140); }
    ctx.textAlign = 'left';
    this.drawMarks(source);
    ctx.restore();
    return { source: crop ? source : 'placeholder', transition: !phase.done };
  }
  drawMarks(source) {
    const ctx = this.context;
    // AI label (always) and brand corner, burned into every exported frame.
    ctx.fillStyle = 'rgba(43, 63, 181, 0.85)'; ctx.fillRect(CLIP_WIDTH - 300, 32, 276, 44);
    ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif';
    ctx.fillText(source === 'test' ? '测试画面 · SoundFace' : 'AI 合成 · SoundFace', CLIP_WIDTH - 286, 61);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)'; ctx.font = '600 30px sans-serif';
    ctx.fillText('SoundFace 声面', 32, CLIP_HEIGHT - 48);
  }
}

if (typeof module !== 'undefined') module.exports = { cropToPortrait, transitionAt, compareAt, drawGenericSilhouette, ClipComposer, CLIP_WIDTH, CLIP_HEIGHT, CLIP_TRANSITION_MS, CLIP_COMPARE_MS };
