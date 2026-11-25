'use strict';
// Local synthetic frames use the same JPEG -> IPC -> native -> CMIO path as
// generated video. No media device or cloud session is opened by this source.
class LocalTestSource {
  constructor(canvas, { now = Date.now, schedule = (tick, period) => setInterval(tick, period), unschedule = timer => clearInterval(timer), fps = 15 } = {}) {
    Object.assign(this, { canvas, now, schedule, unschedule, fps });
    canvas.width = 1280; canvas.height = 720;
    this.context = canvas.getContext('2d', { alpha: false }); this.timer = null;
  }
  get running() { return this.timer != null; }
  start(onFrame) {
    if (this.running) return;
    this.frame = 0; this.startedAt = this.now();
    const tick = () => { this.draw(); onFrame(this.canvas); };
    this.timer = this.schedule(tick, Math.ceil(1000 / this.fps)); tick();
  }
  stop() { if (this.timer != null) this.unschedule(this.timer); this.timer = null; }
  draw() {
    const ctx = this.context, frame = ++this.frame, elapsed = (this.now() - this.startedAt) / 1000;
    ctx.fillStyle = '#17251f'; ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#e0f7e9'; ctx.font = '600 44px sans-serif'; ctx.fillText('SOUNDFACE CAMERA', 64, 100);
    ctx.fillStyle = '#90b19d'; ctx.font = '24px sans-serif'; ctx.fillText('LOCAL TEST  /  NO CAMERA  /  NO CLOUD', 64, 148);
    const colors = ['#eef6f1', '#eedc7e', '#7fd3d2', '#5fd49a', '#b594d5', '#d98884', '#7796cb', '#4e6557'];
    colors.forEach((color, index) => { ctx.fillStyle = color; ctx.fillRect(64 + index * 144, 194, 144, 90); });
    for (let index = 0; index < 16; index++) { ctx.fillStyle = index % 2 ? '#2c4738' : '#355340'; ctx.fillRect(64 + index * 72, 322, 72, 148); }
    const x = 64 + (frame * 9) % 1068;
    ctx.fillStyle = '#5fd49a'; ctx.fillRect(x, 340, 84, 112);
    ctx.fillStyle = '#e0f7e9'; ctx.font = '600 66px monospace'; ctx.fillText('FRAME ' + String(frame).padStart(6, '0'), 64, 584);
    ctx.fillStyle = '#90b19d'; ctx.font = '25px monospace'; ctx.fillText(elapsed.toFixed(1) + ' s   |   1280 x 720   |   ' + this.fps + ' fps', 64, 638);
  }
}
if (typeof module !== 'undefined') module.exports = { LocalTestSource };
