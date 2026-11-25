'use strict';
// Accounts, time quota and generation sessions. Provider-agnostic: providers
// implement create({ image }) → { liveId, secret, connId?, transport, control },
// hangup({ liveId, connId, secret }) and status({ liveId }).
const { randomUUID, randomBytes } = require('node:crypto');

const MIN_START_SECONDS = 60;      // Refuse to start with less than this left.
const HEARTBEAT_TIMEOUT_MS = 30000; // Hang up sessions whose client went quiet.
const CREATE_TIMEOUT_MS = 120000;  // Upstream create calls time out well before this.

class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

class SessionService {
  constructor({ store, provider, authenticators = [], now = Date.now, defaultQuotaSeconds = 600, pollDelay = 500, pollAttempts = 8 }) {
    Object.assign(this, { store, provider, now, defaultQuotaSeconds, pollDelay, pollAttempts });
    this.authenticators = new Map(authenticators.map(item => [item.method, item]));
  }
  // ---- accounts ----
  async login(method, body) {
    const authenticator = this.authenticators.get(method);
    if (!authenticator) throw new ServiceError(404, 'LOGIN_METHOD_UNAVAILABLE', '该登录方式不可用');
    const { accountId, name } = await authenticator.verify(body);
    const existing = this.store.user(accountId);
    const user = this.store.upsertUser(existing ? { id: accountId, name } : { id: accountId, name, quotaSeconds: this.defaultQuotaSeconds, usedSeconds: 0, createdAt: this.now() });
    const token = randomBytes(32).toString('base64url');
    this.store.addToken(token, user.id, this.now());
    return { token, account: this.account(user) };
  }
  async requestCode(method, body) {
    const authenticator = this.authenticators.get(method);
    if (!authenticator?.requestCode) throw new ServiceError(404, 'LOGIN_METHOD_UNAVAILABLE', '该登录方式不可用');
    return authenticator.requestCode(body);
  }
  authenticate(token) {
    const user = typeof token === 'string' && token ? this.store.tokenUser(token) : null;
    if (!user) throw new ServiceError(401, 'UNAUTHENTICATED', '请先登录');
    return user;
  }
  account(user) {
    const fresh = this.store.user(user.id);
    return { id: fresh.id, name: fresh.name, quotaSeconds: fresh.quotaSeconds, usedSeconds: fresh.usedSeconds, remainingSeconds: Math.max(0, fresh.quotaSeconds - fresh.usedSeconds), activeSession: this.activeSession(fresh.id)?.id || null };
  }
  grant(userId, seconds) {
    const user = this.store.user(userId);
    if (!user || !Number.isSafeInteger(seconds)) throw new ServiceError(400, 'BAD_GRANT', '额度调整无效');
    return this.store.upsertUser({ id: userId, quotaSeconds: user.quotaSeconds + seconds });
  }
  // ---- sessions ----
  activeSession(userId) { return this.store.sessions(item => item.userId === userId && ['creating', 'active', 'ending', 'unknown'].includes(item.state))[0] || null; }
  async createSession(user, { image }) {
    const remaining = this.account(user).remainingSeconds;
    if (remaining < MIN_START_SECONDS) throw new ServiceError(402, 'QUOTA_EXHAUSTED', '剩余时长不足，无法开始新会话');
    if (this.activeSession(user.id)) throw new ServiceError(409, 'SESSION_ACTIVE', '上一场会话尚未结束确认，请先结束');
    const session = this.store.putSession({ id: randomUUID(), userId: user.id, provider: this.provider.name, state: 'creating', createdAt: this.now(), lastSeenAt: this.now(), liveId: null, settled: false });
    let created;
    try { created = await this.provider.create({ image }); }
    catch (error) {
      // An upstream that created a live but returned a bad payload must still be ended.
      if (error.liveId) { this.store.putSession({ ...session, liveId: error.liveId, state: 'ending', endReason: 'create_failed' }); void this.finish(session.id); }
      else this.store.putSession({ ...session, state: 'failed', endedAt: this.now() });
      throw new ServiceError(502, 'UPSTREAM_CREATE_FAILED', '生成服务暂时不可用');
    }
    this.store.putSession({ ...this.store.session(session.id), state: 'active', liveId: created.liveId, connId: created.connId || created.control?.connId || null, secret: created.secret || null, startedAt: this.now(), lastSeenAt: this.now() });
    return { sessionId: session.id, provider: this.provider.name, transport: created.transport, control: created.control, remainingSeconds: remaining };
  }
  own(user, sessionId) {
    const session = this.store.session(sessionId);
    if (!session || session.userId !== user.id) throw new ServiceError(404, 'SESSION_NOT_FOUND', '会话不存在');
    return session;
  }
  heartbeat(user, sessionId) {
    const session = this.own(user, sessionId);
    if (session.state === 'active') this.store.putSession({ ...session, lastSeenAt: this.now() });
    return this.view(sessionId);
  }
  view(sessionId) {
    const session = this.store.session(sessionId);
    return { sessionId: session.id, state: session.state, billedSeconds: session.billedSeconds ?? null, creditsCost: session.creditsCost ?? null, closeReason: session.closeReason || '', traceId: session.traceId || '', endReason: session.endReason || '' };
  }
  async hangup(user, sessionId, reason = 'user_hangup') {
    const session = this.own(user, sessionId);
    if (['ended', 'failed'].includes(session.state)) return this.view(sessionId);
    this.store.putSession({ ...session, state: 'ending', endReason: session.endReason || reason });
    return this.finish(sessionId);
  }
  // Hang up upstream and poll until the provider confirms the end. Settlement
  // deducts the provider's billed seconds exactly once. Unconfirmed → 'unknown'
  // (mirrors the client's billing: 'unknown'), retried by the reaper.
  async finish(sessionId) {
    if (!this.finishing) this.finishing = new Map();
    if (this.finishing.has(sessionId)) return this.finishing.get(sessionId);
    const work = (async () => {
      const session = this.store.session(sessionId);
      if (!session.liveId) { this.store.putSession({ ...session, state: 'failed', endedAt: this.now() }); return this.view(sessionId); }
      try { await this.provider.hangup({ liveId: session.liveId, connId: session.connId, secret: session.secret }); } catch { /* status below is authoritative */ }
      for (let attempt = 0; attempt < this.pollAttempts; attempt++) {
        let status = null;
        try { status = await this.provider.status({ liveId: session.liveId }); } catch { /* retry */ }
        if (status?.status === 'ended') { this.settle(sessionId, status); return this.view(sessionId); }
        if (this.pollDelay) await new Promise(resolve => setTimeout(resolve, this.pollDelay));
      }
      this.store.putSession({ ...this.store.session(sessionId), state: 'unknown' });
      return this.view(sessionId);
    })().finally(() => this.finishing.delete(sessionId));
    this.finishing.set(sessionId, work);
    return work;
  }
  settle(sessionId, status) {
    const session = this.store.session(sessionId);
    if (session.settled) return;
    const fallback = Math.ceil((this.now() - (session.startedAt || session.createdAt)) / 1000);
    const billed = Number.isFinite(status.billedSeconds) ? Math.max(0, Math.ceil(status.billedSeconds)) : fallback;
    const user = this.store.user(session.userId);
    this.store.upsertUser({ id: user.id, usedSeconds: user.usedSeconds + billed });
    this.store.putSession({ ...session, state: 'ended', settled: true, endedAt: this.now(), billedSeconds: billed, billedFromProvider: Number.isFinite(status.billedSeconds), creditsCost: status.creditsCost ?? null, closeReason: status.closeReason || '', traceId: status.traceId || '' });
  }
  // Called periodically: hang up sessions whose client stopped heartbeating or
  // whose elapsed time reached the account's remaining quota; retry unknowns.
  async reap() {
    const now = this.now(), work = [];
    // A 'creating' record older than the create timeout was orphaned (e.g. server crash mid-create).
    for (const session of this.store.sessions(item => item.state === 'creating' && now - item.createdAt > CREATE_TIMEOUT_MS)) {
      this.store.putSession({ ...session, state: 'failed', endReason: 'create_orphaned', endedAt: now });
    }
    for (const session of this.store.sessions(item => ['active', 'ending', 'unknown'].includes(item.state))) {
      if (session.state !== 'active') { work.push(this.finish(session.id)); continue; }
      const user = this.store.user(session.userId), remaining = user.quotaSeconds - user.usedSeconds;
      const elapsed = (now - (session.startedAt || session.createdAt)) / 1000;
      const reason = now - session.lastSeenAt > HEARTBEAT_TIMEOUT_MS ? 'client_lost' : elapsed >= remaining ? 'quota_reached' : null;
      if (reason) { this.store.putSession({ ...session, state: 'ending', endReason: reason }); work.push(this.finish(session.id)); }
    }
    return Promise.all(work);
  }
}

module.exports = { SessionService, ServiceError, MIN_START_SECONDS, HEARTBEAT_TIMEOUT_MS, CREATE_TIMEOUT_MS };
