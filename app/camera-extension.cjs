const { EventEmitter } = require('node:events');

class CameraExtension extends EventEmitter {
  constructor(native) { super(); this.native = native; this.timer = null; }
  snapshot() {
    if (!this.native) return { phase: 'unavailable', message: '激活模块尚未构建，请重新构建开发包。' };
    return { ...JSON.parse(this.native.inspect()), ...JSON.parse(this.native.status()) };
  }
  activate() {
    if (!this.native) throw new Error('摄像头激活模块不可用');
    JSON.parse(this.native.activate());
    clearInterval(this.timer);
    const poll = () => {
      const state = this.snapshot(); this.emit('state', state);
      if (!['activating', 'awaiting_approval'].includes(state.phase)) { clearInterval(this.timer); this.timer = null; }
      return state;
    };
    this.timer = setInterval(poll, 500); this.timer.unref();
    return poll();
  }
  close() { clearInterval(this.timer); this.timer = null; }
}
module.exports = { CameraExtension };
