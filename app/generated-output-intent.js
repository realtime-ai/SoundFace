'use strict';
// A user request attaches output once, only after a real generated frame.
// Cancelling while a native start is pending must stop that late start.
class GeneratedOutputIntent {
  constructor({ start, stop }) { Object.assign(this, { start, stop }); this.generation = 0; this.requested = false; this.pending = false; }
  get active() { return this.requested || this.pending; }
  request() { this.cancel(); this.requested = true; }
  cancel() { this.generation++; this.requested = false; }
  async onFrame(ready) {
    if (!this.requested || this.pending) return null;
    this.requested = false; this.pending = true;
    const generation = this.generation;
    try {
      await ready();
      if (generation !== this.generation) return null;
      const state = await this.start();
      if (generation !== this.generation) { await this.stop(); return null; }
      return state;
    } finally { this.pending = false; }
  }
}
if (typeof module !== 'undefined') module.exports = { GeneratedOutputIntent };
