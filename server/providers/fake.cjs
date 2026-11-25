'use strict';
// Simulated generation provider: no network, no cost. Bills elapsed whole
// seconds between create and hangup, like the real service's settlement.
const { randomUUID } = require('node:crypto');

class FakeProvider {
  constructor({ now = Date.now, failCreate = false, neverEnds = false } = {}) {
    Object.assign(this, { now, failCreate, neverEnds });
    this.name = 'fake'; this.lives = new Map(); this.calls = [];
  }
  async create({ image }) {
    this.calls.push(['create']);
    if (this.failCreate) throw Object.assign(new Error('上游创建失败'), { code: 'UPSTREAM_CREATE_FAILED' });
    if (typeof image !== 'string' || !image.startsWith('data:image/')) throw Object.assign(new Error('参考图无效'), { code: 'BAD_IMAGE' });
    const liveId = 'fake-' + randomUUID();
    this.lives.set(liveId, { startedAt: this.now(), endedAt: null });
    return {
      liveId, secret: null,
      transport: { type: 'fake', room: liveId },
      control: { type: 'none' }
    };
  }
  async hangup({ liveId }) {
    this.calls.push(['hangup', liveId]);
    const live = this.lives.get(liveId);
    if (live && !this.neverEnds && live.endedAt == null) live.endedAt = this.now();
  }
  async status({ liveId }) {
    const live = this.lives.get(liveId);
    if (!live) return { status: 'unknown' };
    if (live.endedAt == null) return { status: 'on_live' };
    return { status: 'ended', billedSeconds: Math.ceil((live.endedAt - live.startedAt) / 1000), closeReason: 'user_hangup' };
  }
}

module.exports = { FakeProvider };
