const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');

class AudioBridge extends EventEmitter {
  constructor(binary, label = '虚拟麦克风') { super(); this.label = label; this.binary = binary; this.pending = new Map(); this.sequence = 0; this.child = null; }
  launch() {
    if (this.child) return;
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const fail = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(this.label + '停了，请重新开启。')); }
      this.pending.clear();
      this.emit('stopped', this.label + '停了，请重新开启。');
    };
    child.on('error', fail); child.on('exit', fail);
    child.stdin.on('error', fail);
    // Never forward raw native logs to the renderer.
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      let data; try { data = JSON.parse(line); } catch { return; }
      if (data.event === 'frames') this.emit('frames', { submitted: data.submitted, dropped: data.dropped, converted: data.converted || 0 });
      if (data.event === 'levels') this.emit('levels', { inputPeak: data.inputPeak, outputPeak: data.outputPeak, capturedFrames: data.capturedFrames, outputFrames: data.outputFrames, sampleRate: data.sampleRate, inputSampleRate: data.inputSampleRate });
      if (data.event === 'stopped') this.emit('stopped', data.reason);
      const request = this.pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(data.id);
      if (data.ok) request.resolve(data); else request.reject(new Error(data.error || '没有成功，请再试一次。'));
    });
  }
  command(action, args = {}) {
    this.launch();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.label + '停了，请重新开启。'));
        this.child?.kill();
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...args, action, id }) + '\n');
    });
  }
  close() { this.child?.stdin.end(); }
}
module.exports = { AudioBridge };
