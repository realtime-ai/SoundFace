const { EventEmitter } = require('node:events');

// One operation queue per medium. Privacy invalidates pending permission and start
// operations immediately, so an old grant cannot resume capture after a pause.
class CaptureController extends EventEmitter {
  constructor(bridge, permission, label = '摄像头') {
    super(); this.bridge = bridge; this.permission = permission; this.label = label; this.queue = Promise.resolve(); this.generation = 0;
    this.state = { running: false, muted: false, inputUID: '', privacy: false, error: '', submitted: 0, dropped: 0 };
    bridge.on('stopped', reason => { this.generation++; this.state.running = false; this.state.muted = false; this.state.levels = null; this.state.error = reason; this.publish(); });
    bridge.on('frames', counts => { if (this.state.running) { this.state.submitted = counts.submitted; this.state.dropped = counts.dropped; this.state.converted = counts.converted || 0; this.publish(); } });
    bridge.on('levels', levels => { if (this.state.running) { this.state.levels = levels; this.publish(); } });
  }
  snapshot() { return { ...this.state }; }
  publish() { const state = this.snapshot(); this.emit('state', state); return state; }
  serial(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  check(token) {
    if (this.state.privacy) throw new Error('已进入隐私暂停，摄像头和麦克风都关了。退出后需要你自己重新开启。');
    if (token !== this.generation) throw new Error('已取消');
  }
  start(uid, nativeOptions = {}) {
    const token = ++this.generation;
    return this.serial(async () => {
      this.check(token);
      if (!await this.permission(uid)) throw new Error(`没有${this.label}权限。请到“系统设置 → 隐私与安全性 → ${this.label}”里允许 SoundFace。`);
      this.check(token);
      try {
        await this.bridge.command('start', { ...nativeOptions, uid });
        this.check(token);
      } catch (error) {
        // A native start can complete after the user has paused. Stop before releasing the queue.
        if (token !== this.generation || this.state.privacy) await this.bridge.command('stop').catch(() => {});
        this.state.running = false; this.state.error = error.message; this.publish(); throw error;
      }
      Object.assign(this.state, { running: true, muted: false, inputUID: uid, error: '', submitted: 0, dropped: 0, converted: 0, levels: null }); return this.publish();
    });
  }
  async stopNative() {
    try { await this.bridge.command('stop'); }
    finally { Object.assign(this.state, { running: false, muted: false, submitted: 0, dropped: 0, levels: null }); this.publish(); }
  }
  stop() { this.generation++; return this.serial(() => this.stopNative()); }
  mute(value) {
    return this.serial(async () => {
      if (!this.state.running || this.state.privacy) throw new Error('请先开启虚拟麦克风');
      await this.bridge.command('mute', { muted: value }); this.state.muted = value; return this.publish();
    });
  }
  setPrivacy(value) {
    this.generation++; this.state.privacy = value; this.publish();
    return value ? this.serial(async () => { await this.stopNative(); return this.snapshot(); }) : Promise.resolve(this.snapshot());
  }
  close() { this.generation++; this.bridge.close(); this.state.running = false; this.state.levels = null; this.publish(); }
}
module.exports = { CaptureController };
