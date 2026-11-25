// One Durable Object per account. It serialises everything that touches the
// balance: sessions, settlement, redeem codes. Balances are kept in seconds;
// users see credits (1 credit = 1 minute). Rules (docs section 14):
//  - users are billed from the first generated frame to the hangup request,
//    never more than the provider billed us; sessions without a frame cost 0;
//  - partial minutes stay in the account (no rounding up);
//  - redeem codes are one-time; 5 wrong attempts lock redeeming for 15 minutes.
import { DurableObject } from 'cloudflare:workers';
import { ServiceError, fail, sha256, intVar } from './util.js';
import { makeProvider } from './providers.js';

const MIN_START_SECONDS = 60;          // need at least 1 credit to start (MIN_START_SECONDS overrides, tests only)
const CREATE_TIMEOUT_MS = 120000;
const TICK_MS = 5000;                  // alarm cadence while a session is open
const POLL_ATTEMPTS = 8, POLL_DELAY_MS = 500;
const REDEEM_MAX_FAILURES = 5, REDEEM_LOCK_MS = 15 * 60 * 1000;
const OPEN = ['creating', 'active', 'ending', 'unknown'];

export const normalizeCode = code => String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^SF/, '');

export class AccountObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql; this.now = () => Date.now(); this.finishing = new Map();
    this.heartbeatTimeoutMs = intVar(env.HEARTBEAT_TIMEOUT_MS, 30000);
    this.minStartSeconds = Math.max(1, intVar(env.MIN_START_SECONDS, MIN_START_SECONDS));
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, seconds INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, state TEXT NOT NULL,
        live_id TEXT, conn_id TEXT, secret TEXT,
        created_at INTEGER NOT NULL, started_at INTEGER, first_frame_at INTEGER, last_seen_at INTEGER NOT NULL,
        end_requested_at INTEGER, ended_at INTEGER, end_reason TEXT NOT NULL DEFAULT '',
        provider_billed INTEGER, billed_seconds INTEGER NOT NULL DEFAULT 0, credits_cost REAL,
        close_reason TEXT NOT NULL DEFAULT '', trace_id TEXT NOT NULL DEFAULT '', settled INTEGER NOT NULL DEFAULT 0);
    `);
  }
  // Single RPC entry: Workers RPC does not carry custom error fields, so errors
  // come back as data and the router turns them into HTTP responses.
  async call(method, arg) {
    if (!['ensure', 'account', 'history', 'createSession', 'heartbeat', 'view', 'hangup', 'redeem'].includes(method)) return { ok: false, status: 404, code: 'NOT_FOUND', message: '接口不存在' };
    try {
      if (['heartbeat', 'view', 'hangup'].includes(method)) this.own(arg.sessionId);
      const value = method === 'heartbeat' ? this.heartbeat(arg.sessionId, arg) : ['view', 'hangup'].includes(method) ? await this[method](arg.sessionId) : await this[method](arg || {});
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ServiceError) return { ok: false, status: error.status, code: error.code, message: error.message };
      console.error('[account]', error); return { ok: false, status: 500, code: 'INTERNAL', message: '服务内部错误' };
    }
  }
  // ---- small storage helpers ----
  meta(key) { return this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value ?? null; }
  setMeta(key, value) { this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value)); }
  session(id) { return this.sql.exec('SELECT * FROM sessions WHERE id = ?', id).toArray()[0] || null; }
  update(id, fields) {
    const keys = Object.keys(fields);
    this.sql.exec(`UPDATE sessions SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`, ...keys.map(key => fields[key]), id);
  }
  openSession() { return this.sql.exec(`SELECT * FROM sessions WHERE state IN (${OPEN.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`, ...OPEN).toArray()[0] || null; }
  totals() {
    const bought = this.sql.exec('SELECT COALESCE(SUM(seconds), 0) AS s FROM purchases').one().s;
    const used = this.sql.exec('SELECT COALESCE(SUM(billed_seconds), 0) AS s FROM sessions WHERE settled = 1').one().s;
    return { bought, used, balance: Math.max(0, bought - used) };
  }
  provider() {
    if (!this._provider) {
      try { this._provider = makeProvider(this.env, { sql: this.sql, now: this.now }); }
      catch (error) { console.error('[provider]', error.message); fail(503, 'PROVIDER_UNAVAILABLE', '生成服务暂不可用'); }
    }
    return this._provider;
  }
  // Seconds a live session has consumed so far (billing starts at the first frame).
  liveUsage(session, at = this.now()) {
    if (!session?.first_frame_at) return 0;
    return Math.max(0, Math.floor(((session.end_requested_at || at) - session.first_frame_at) / 1000));
  }

  // ---- account ----
  ensure({ id, name, trialSeconds = 0 }) {
    if (!this.meta('id')) {
      this.setMeta('id', id); this.setMeta('created_at', this.now());
      if (trialSeconds > 0) this.sql.exec('INSERT INTO purchases (id, source, ref, seconds, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', crypto.randomUUID(), 'trial', 'trial', trialSeconds, '新用户试用', this.now());
    }
    this.setMeta('name', name);
    return this.account();
  }
  account() {
    const { bought, used, balance } = this.totals(), open = this.openSession();
    const remainingSeconds = Math.max(0, balance - (open?.state === 'active' ? this.liveUsage(open) : 0));
    return { id: this.meta('id'), name: this.meta('name'), quotaSeconds: bought, usedSeconds: used, remainingSeconds, remainingMinutes: Math.floor(remainingSeconds / 60), activeSession: open?.id || null };
  }
  history() {
    const purchases = this.sql.exec('SELECT source, seconds, note, created_at FROM purchases ORDER BY created_at DESC LIMIT 200').toArray()
      .map(row => ({ source: row.source, credits: row.seconds / 60, note: row.note, at: row.created_at }));
    const sessions = this.sql.exec("SELECT id, first_frame_at, created_at, end_requested_at, ended_at, billed_seconds, state, end_reason FROM sessions WHERE state IN ('ended', 'unknown', 'ending', 'active') ORDER BY created_at DESC LIMIT 200").toArray()
      .map(row => ({ sessionId: row.id, startedAt: row.first_frame_at || row.created_at, seconds: row.billed_seconds, credits: Math.round(row.billed_seconds / 60 * 100) / 100, state: row.state, endReason: row.end_reason }));
    return { purchases, sessions };
  }

  // ---- sessions ----
  async createSession({ image }) {
    const { balance } = this.totals();
    if (balance < this.minStartSeconds) fail(402, 'QUOTA_EXHAUSTED', '余额不足 1 分钟，请先充值');
    if (this.openSession()) fail(409, 'SESSION_ACTIVE', '上一场会话尚未结束确认，请先结束');
    const provider = this.provider(), id = crypto.randomUUID(), now = this.now();
    // Insert before the upstream await so a concurrent request sees an open session.
    this.sql.exec('INSERT INTO sessions (id, provider, state, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', id, provider.name, 'creating', now, now);
    await this.schedule();
    let created;
    try { created = await provider.create({ image }); }
    catch (error) {
      if (error.liveId) { this.update(id, { live_id: error.liveId, state: 'ending', end_reason: 'create_failed', end_requested_at: this.now() }); this.ctx.waitUntil(this.finish(id)); }
      else this.update(id, { state: 'failed', ended_at: this.now(), end_reason: 'create_failed' });
      fail(502, 'UPSTREAM_CREATE_FAILED', '生成服务暂时不可用');
    }
    this.update(id, { state: 'active', live_id: created.liveId, conn_id: created.connId || null, secret: created.secret || null, started_at: this.now(), last_seen_at: this.now() });
    return { sessionId: id, provider: provider.name, transport: created.transport, control: created.control, remainingSeconds: balance };
  }
  own(id) { const session = this.session(id); if (!session) fail(404, 'SESSION_NOT_FOUND', '会话不存在'); return session; }
  heartbeat(id, { frames = 0 } = {}) {
    const session = this.own(id);
    if (session.state === 'active') {
      const fields = { last_seen_at: this.now() };
      // The client reports the generated frames it has displayed; billing starts at the first one.
      if (!session.first_frame_at && Number(frames) > 0) fields.first_frame_at = this.now();
      this.update(id, fields);
    }
    return this.view(id);
  }
  view(id) {
    const session = this.session(id), { balance } = this.totals();
    return {
      sessionId: session.id, state: session.state, firstFrameAt: session.first_frame_at || null,
      billedSeconds: session.settled ? session.billed_seconds : null, creditsCost: session.credits_cost ?? null,
      remainingSeconds: Math.max(0, balance - (session.settled ? 0 : this.liveUsage(session))),
      closeReason: session.close_reason, traceId: session.trace_id, endReason: session.end_reason
    };
  }
  async hangup(id, reason = 'user_hangup') {
    const session = this.own(id);
    if (['ended', 'failed'].includes(session.state)) return this.view(id);
    if (session.state !== 'ending' && session.state !== 'unknown') this.update(id, { state: 'ending', end_reason: session.end_reason || reason, end_requested_at: session.end_requested_at || this.now() });
    return this.finish(id);
  }
  // Hang up upstream and poll until the provider confirms the end, then settle once.
  finish(id) {
    if (this.finishing.has(id)) return this.finishing.get(id);
    const work = (async () => {
      const session = this.session(id);
      if (!session.live_id) { this.update(id, { state: 'failed', ended_at: this.now() }); return this.view(id); }
      const provider = this.provider();
      try { await provider.hangup({ liveId: session.live_id, connId: session.conn_id, secret: session.secret }); } catch { /* status decides */ }
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        let status = null;
        try { status = await provider.status({ liveId: session.live_id }); } catch { /* retry */ }
        if (status?.status === 'ended') { this.settle(id, status); return this.view(id); }
        await new Promise(resolve => setTimeout(resolve, POLL_DELAY_MS));
      }
      this.update(id, { state: 'unknown' }); await this.schedule();
      return this.view(id);
    })().finally(() => this.finishing.delete(id));
    this.finishing.set(id, work);
    return work;
  }
  settle(id, status) {
    const session = this.session(id);
    if (session.settled) return;
    const providerBilled = Number.isFinite(status.billedSeconds) ? Math.max(0, Math.ceil(status.billedSeconds)) : null;
    let billed = this.liveUsage(session, session.end_requested_at || this.now());
    if (providerBilled != null) billed = Math.min(billed, providerBilled);
    billed = Math.min(billed, this.totals().balance);
    this.update(id, { state: 'ended', settled: 1, ended_at: this.now(), provider_billed: providerBilled, billed_seconds: billed, credits_cost: status.creditsCost ?? null, close_reason: status.closeReason || '', trace_id: status.traceId || '' });
  }
  async schedule() { if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(this.now() + TICK_MS); }
  // Hang up sessions whose client went quiet or ran out of balance; retry unconfirmed ends.
  async alarm() {
    const now = this.now(), work = [];
    for (const session of this.sql.exec(`SELECT * FROM sessions WHERE state IN (${OPEN.map(() => '?').join(',')})`, ...OPEN).toArray()) {
      if (session.state === 'creating') { if (now - session.created_at > CREATE_TIMEOUT_MS) this.update(session.id, { state: 'failed', end_reason: 'create_orphaned', ended_at: now }); continue; }
      if (session.state !== 'active') { work.push(this.finish(session.id)); continue; }
      const remaining = this.totals().balance - this.liveUsage(session, now);
      const reason = now - session.last_seen_at > this.heartbeatTimeoutMs ? 'client_lost' : session.first_frame_at && remaining <= 0 ? 'quota_reached' : null;
      // A lost client is billed only up to its last heartbeat.
      if (reason) { this.update(session.id, { state: 'ending', end_reason: reason, end_requested_at: reason === 'client_lost' ? Math.max(session.last_seen_at, session.first_frame_at || 0) : now }); work.push(this.finish(session.id)); }
    }
    await Promise.allSettled(work);
    if (this.openSession()) await this.ctx.storage.setAlarm(this.now() + TICK_MS);
  }

  // ---- redeem codes ----
  async redeem({ code }) {
    const lockedUntil = Number(this.meta('redeem_locked_until') || 0);
    if (lockedUntil > this.now()) fail(429, 'REDEEM_LOCKED', `输错次数过多，请 ${Math.ceil((lockedUntil - this.now()) / 60000)} 分钟后再试`);
    const normalized = normalizeCode(code);
    let row = null;
    if (normalized.length >= 12 && normalized.length <= 32) {
      row = await this.env.DB.prepare('UPDATE redeem_codes SET redeemed_by = ?, redeemed_at = ? WHERE code_hash = ? AND redeemed_by IS NULL AND (expires_at IS NULL OR expires_at > ?) RETURNING code_hash, credits, batch')
        .bind(this.meta('id'), this.now(), await sha256(normalized), this.now()).first();
    }
    if (!row) {
      const failures = Number(this.meta('redeem_failures') || 0) + 1;
      if (failures >= REDEEM_MAX_FAILURES) { this.setMeta('redeem_failures', 0); this.setMeta('redeem_locked_until', this.now() + REDEEM_LOCK_MS); }
      else this.setMeta('redeem_failures', failures);
      fail(400, 'REDEEM_INVALID', failures >= REDEEM_MAX_FAILURES ? '兑换码无效。输错次数过多，请 15 分钟后再试' : '兑换码无效、已被使用或已过期');
    }
    this.setMeta('redeem_failures', 0);
    this.sql.exec('INSERT INTO purchases (id, source, ref, seconds, note, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (ref) DO NOTHING', crypto.randomUUID(), 'redeem', 'code:' + row.code_hash, row.credits * 60, '兑换码 …' + normalized.slice(-4), this.now());
    return { credits: row.credits, account: this.account() };
  }
}
export { ServiceError };
