'use strict';
// Functional-validation transport. The canvas only reads the subscribed remote
// video, never the local camera or UI. JPEG is capped at 30 fps / 512 KiB.
class RemoteFramePump {
  constructor({ route, send, fail, canvas, now = Date.now, clock = () => performance.now() }) {
    Object.assign(this, { route, send, fail, now, clock });
    this.canvas = canvas || document.createElement('canvas');
    this.canvas.width = 1280; this.canvas.height = 720;
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.busy = false; this.generation = 0; this.last = -Infinity;
    this.stats = { forwarded: 0, skipped: 0, encodeMs: 0, bridgeMs: 0 };
  }
  reset() { this.generation++; this.last = -Infinity; }
  async offer(element) {
    const route = this.route();
    const sourceWidth = element.videoWidth || element.width, sourceHeight = element.videoHeight || element.height;
    if (!route || !sourceWidth || !sourceHeight) return;
    const start = this.clock();
    // Allow 2 ms of callback jitter at the 30 fps boundary; work is still single-flight.
    if (this.busy || start - this.last < 1000 / 30 - 2) { this.stats.skipped++; return; }
    this.last = start; this.busy = true;
    const generation = this.generation, capturedAt = this.now();
    const valid = () => generation === this.generation && this.route()?.frameToken === route.frameToken;
    try {
      const ctx = this.context, scale = Math.min(1280 / sourceWidth, 720 / sourceHeight);
      const width = sourceWidth * scale, height = sourceHeight * scale;
      ctx.fillStyle = '#17251f'; ctx.fillRect(0, 0, 1280, 720);
      ctx.drawImage(element, (1280 - width) / 2, (720 - height) / 2, width, height);
      // Burn the synthesis label into pixels so downstream apps retain it.
      ctx.fillStyle = '#173c30'; ctx.fillRect(970, 24, 286, 44);
      ctx.fillStyle = '#dcffeb'; ctx.font = '20px sans-serif';
      ctx.fillText(route.kind === 'test' ? '测试画面 · SoundFace' : 'AI 合成 · SoundFace', 982, 53);
      const blob = await new Promise(resolve => this.canvas.toBlob(resolve, 'image/jpeg', 0.86));
      if (!valid() || !blob || blob.size > 524288 || this.now() - capturedAt > 250) { this.stats.skipped++; return; }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!valid()) return;
      const encoded = this.clock();
      const result = await this.send({ ...route, capturedAt, bytes });
      if (result.forwarded) {
        const count = ++this.stats.forwarded;
        this.stats.encodeMs += (encoded - start - this.stats.encodeMs) / count;
        this.stats.bridgeMs += (this.clock() - encoded - this.stats.bridgeMs) / count;
      } else this.stats.skipped++;
    } catch (error) {
      if (valid()) { this.reset(); await this.fail(error); }
    } finally { this.busy = false; }
  }
}
if (typeof module !== 'undefined') module.exports = { RemoteFramePump };
