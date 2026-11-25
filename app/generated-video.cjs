// Prototype transport only. One native request in flight; no growing video queue.
// The authoritative session and output state remain in the main process.
const { randomUUID } = require('node:crypto');
class GeneratedVideoRelay {
  constructor(bridge, allowed, now = Date.now) { this.bridge = bridge; this.allowed = allowed; this.now = now; this.liveID = null; this.busy = false; }
  arm(liveID) { this.liveID = liveID; this.frameToken = randomUUID(); return this.frameToken; }
  disarm() { this.liveID = null; this.frameToken = null; }
  async frame(packet) {
    if (!this.liveID || this.busy || !this.allowed(this.liveID) || packet?.liveID !== this.liveID || packet.frameToken !== this.frameToken) return { forwarded: false };
    const age = this.now() - packet.capturedAt;
    if (!Number.isFinite(age) || age < -50 || age > 250) return { forwarded: false };
    if (!(packet.bytes instanceof Uint8Array) || packet.bytes.length < 4 || packet.bytes.length > 524288 || packet.bytes[0] !== 0xff || packet.bytes[1] !== 0xd8) throw new Error('出了点问题，请再试一次。（错误代码：生成帧格式无效）');
    this.busy = true;
    try {
      await this.bridge.command('frame', { liveID: this.liveID, capturedAt: packet.capturedAt, jpeg: Buffer.from(packet.bytes).toString('base64') });
      return { forwarded: true };
    } finally { this.busy = false; }
  }
}
module.exports = { GeneratedVideoRelay };
