const { EventEmitter } = require('node:events');

class CameraExtension extends EventEmitter {
  constructor(native) { super(); this.native = native; this.timer = null; }
  snapshot() {
    if (!this.native) return { phase: 'unavailable', message: '安装程序打不开，请重新下载安装 SoundFace。' };
    return { ...JSON.parse(this.native.inspect()), ...JSON.parse(this.native.status()) };
  }
  activate() {
    if (!this.native) throw new Error('安装程序打不开，请重新下载安装 SoundFace。');
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
