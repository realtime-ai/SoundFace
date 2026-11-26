// One Durable Object per account. It serialises everything that touches the
// balance: sessions, settlement, redeem codes. Balances are kept in seconds;
// users see credits (1 credit = 1 minute). Rules (docs section 14):
//  - users are billed from the first generated frame to the hangup request,
//    never more than the provider billed us; sessions without a frame cost 0;
//  - partial minutes stay in the account (no rounding up);
//  - redeem codes are one-time; 5 wrong attempts lock redeeming for 15 minutes.
// Every balance change and finished session is also mirrored to D1 summary
// tables for the admin console (src/mirror.js): the op goes into an outbox in
// this object's storage in the same turn, is flushed right away, and is retried
// from the alarm until D1 accepts it.
import { DurableObject } from 'cloudflare:workers';
import { ServiceError, fail, intVar } from './util.js';
import { makeProvider } from './providers.js';
import { normalizeCode, hashCode } from './codes.js';
import { mirrorStatements } from './mirror.js';

const MIN_START_SECONDS = 60;          // need at least 1 credit to start (MIN_START_SECONDS overrides, tests only)
const CREATE_TIMEOUT_MS = 120000;
const TICK_MS = 5000;                  // alarm cadence while a session is open
const POLL_ATTEMPTS = 8, POLL_DELAY_MS = 500;
const REDEEM_MAX_FAILURES = 5, REDEEM_LOCK_MS = 15 * 60 * 1000;
const OPEN = ['creating', 'active', 'ending', 'unknown'];
const MIRROR_VERSION = '1';             // bump to resend everything to D1 once per account
const MIRROR_CHUNK = 40, MIRROR_MAX_DELAY_MS = 10 * 60 * 1000;
const SOURCES = ['trial', 'redeem', 'admin'];
const minutesText = seconds => `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : '钟'}`;

export { normalizeCode };

export class AccountObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql; this.now = () => Date.now(); this.finishing = new Map();
    this.heartbeatTimeoutMs = intVar(env.HEARTBEAT_TIMEOUT_MS, 30000);
    this.minStartSeconds = Math.max(1, intVar(env.MIN_START_SECONDS, MIN_START_SECONDS));
    this.mirrorRetryMs = Math.max(100, intVar(env.MIRROR_RETRY_MS, 15000)); this.mirrorFailures = 0; this.flushing = null;
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
      CREATE TABLE IF NOT EXISTS adjustments (purchase_id TEXT PRIMARY KEY, reason TEXT NOT NULL, actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
  }
  // Single RPC entry: Workers RPC does not carry custom error fields, so errors
  // come back as data and the router turns them into HTTP responses.
  async call(method, arg) {
    if (!['ensure', 'account', 'history', 'createSession', 'heartbeat', 'view', 'hangup', 'redeem', 'adjust', 'sync'].includes(method)) return { ok: false, status: 404, code: 'NOT_FOUND', message: '接口不存在' };
    try {
      // Accounts created before the D1 mirror existed resend their history once.
      if (this.meta('id') && this.meta('mirror_version') !== MIRROR_VERSION) await this.sync();
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
      catch (error) { console.error('[provider]', error.message); fail(503, 'PROVIDER_UNAVAILABLE', '数字人服务暂时用不了，请过一会儿再试。'); }
    }
    return this._provider;
  }
  // Seconds a live session has consumed so far (billing starts at the first frame).
  liveUsage(session, at = this.now()) {
    if (!session?.first_frame_at) return 0;
    return Math.max(0, Math.floor(((session.end_requested_at || at) - session.first_frame_at) / 1000));
  }

  // ---- account ----
  async ensure({ id, name, trialSeconds = 0 }) {
    this.ctx.storage.transactionSync(() => {
      if (!this.meta('id')) {
        this.setMeta('id', id); this.setMeta('created_at', this.now()); this.setMeta('mirror_version', MIRROR_VERSION);
        if (trialSeconds > 0) this.addPurchase({ source: 'trial', ref: 'trial', seconds: trialSeconds, note: '新用户试用' });
      }
      this.setMeta('name', name);
      this.enqueue({ type: 'summary' });
    });
    await this.mirror();
    return this.account();
  }
  // Records a balance change and its ledger mirror entry atomically.
  addPurchase({ source, ref, seconds, note, extra = {} }) {
    const id = crypto.randomUUID(), at = this.now();
    this.sql.exec('INSERT INTO purchases (id, source, ref, seconds, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, source, ref, seconds, note, at);
    this.enqueue({ type: 'ledger', row: { id, kind: source, seconds, note, created_at: at, ...extra } }, { type: 'summary' });
    return id;
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
    if (balance < this.minStartSeconds) fail(402, 'QUOTA_EXHAUSTED', '剩余时长不到 1 分钟，请先充值。');
    if (this.openSession()) fail(409, 'SESSION_ACTIVE', '上一次的数字人还没完全停止，请先点“停止数字人”。');
    const provider = this.provider(), id = crypto.randomUUID(), now = this.now();
    // Insert before the upstream await so a concurrent request sees an open session.
    this.sql.exec('INSERT INTO sessions (id, provider, state, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', id, provider.name, 'creating', now, now);
    await this.schedule();
    let created;
    try { created = await provider.create({ image }); }
    catch (error) {
      if (error.liveId) { this.update(id, { live_id: error.liveId, state: 'ending', end_reason: 'create_failed', end_requested_at: this.now() }); this.ctx.waitUntil(this.finish(id)); }
      else this.update(id, { state: 'failed', ended_at: this.now(), end_reason: 'create_failed' });
      fail(502, 'UPSTREAM_CREATE_FAILED', '数字人服务暂时用不了，请过一会儿再试。');
    }
    this.update(id, { state: 'active', live_id: created.liveId, conn_id: created.connId || null, secret: created.secret || null, started_at: this.now(), last_seen_at: this.now() });
    return { sessionId: id, provider: provider.name, transport: created.transport, control: created.control, remainingSeconds: balance };
  }
  own(id) { const session = this.session(id); if (!session) fail(404, 'SESSION_NOT_FOUND', '找不到这一次的数字人记录'); return session; }
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
        if (status?.status === 'ended') { this.settle(id, status); await this.mirror(); return this.view(id); }
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
    this.ctx.storage.transactionSync(() => {
      this.update(id, { state: 'ended', settled: 1, ended_at: this.now(), provider_billed: providerBilled, billed_seconds: billed, credits_cost: status.creditsCost ?? null, close_reason: status.closeReason || '', trace_id: status.traceId || '' });
      this.enqueue(...this.sessionOps(this.session(id)), { type: 'summary' });
    });
  }
  sessionOps(session) {
    const ops = [{ type: 'session', row: { id: session.id, created_at: session.created_at, first_frame_at: session.first_frame_at, ended_at: session.end_requested_at || session.ended_at, billed_seconds: session.billed_seconds, end_reason: session.end_reason } }];
    if (session.billed_seconds > 0) ops.push({ type: 'ledger', row: { id: 'charge:' + session.id, kind: 'usage', seconds: -session.billed_seconds, note: '使用扣除', created_at: session.created_at } });
    return ops;
  }
  // The alarm serves both the session tick and mirror retries: keep the earlier one.
  async schedule(at = this.now() + TICK_MS) {
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > at) await this.ctx.storage.setAlarm(at);
  }
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
    const flushed = await this.flush().catch(() => false), next = [];
    if (this.openSession()) next.push(this.now() + TICK_MS);
    if (!flushed) next.push(this.now() + this.mirrorDelay());
    if (next.length) await this.ctx.storage.setAlarm(Math.min(...next));
  }

  // ---- D1 mirror (outbox) ----
  enqueue(...ops) { for (const op of ops) this.sql.exec('INSERT INTO outbox (op, created_at) VALUES (?, ?)', JSON.stringify(op), this.now()); }
  pendingMirror() { return this.sql.exec('SELECT COUNT(*) AS n FROM outbox').one().n; }
  mirrorDelay() { return Math.min(MIRROR_MAX_DELAY_MS, this.mirrorRetryMs * 2 ** Math.min(10, Math.max(0, this.mirrorFailures - 1))); }
  summary() {
    const { bought, used, balance } = this.totals();
    return { display_id: this.meta('name') || '', created_at: Number(this.meta('created_at')) || this.now(), balance_seconds: balance, recharged_seconds: bought, used_seconds: used,
      last_used_at: this.sql.exec('SELECT MAX(created_at) AS t FROM sessions WHERE settled = 1').one().t ?? null };
  }
  // Sends the outbox to D1 in order; true when it is empty. One flush at a time.
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      for (;;) {
        const rows = this.sql.exec('SELECT seq, op FROM outbox ORDER BY seq LIMIT ?', MIRROR_CHUNK).toArray();
        if (!rows.length) { this.mirrorFailures = 0; return true; }
        const ops = rows.map(row => JSON.parse(row.op)), last = rows.at(-1).seq;
        const summary = ops.some(op => op.type === 'summary') ? this.summary() : null;
        try { await this.env.DB.batch(mirrorStatements(this.env.DB, this.meta('id'), ops, summary, last, this.now())); }
        catch (error) { this.mirrorFailures++; console.error('[mirror] D1 write failed, will retry:', error.message); return false; }
        this.sql.exec('DELETE FROM outbox WHERE seq <= ?', last);
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  // Flush now; if D1 is unavailable keep the outbox and let the alarm retry.
  async mirror() {
    if (!this.meta('id')) return;
    if (!(await this.flush().catch(() => false))) await this.schedule(this.now() + this.mirrorDelay());
  }
  // Resend this account's full history (idempotent). Used once for accounts that
  // existed before the mirror, and by the admin backfill.
  async sync() {
    if (!this.meta('id')) return { pending: 0 };
    this.ctx.storage.transactionSync(() => {
      for (const row of this.sql.exec('SELECT p.*, a.reason, a.actor FROM purchases p LEFT JOIN adjustments a ON a.purchase_id = p.id').toArray()) {
        const hash = row.ref.startsWith('code:') ? row.ref.slice(5) : null;
        this.enqueue({ type: 'ledger', row: { id: row.id, kind: SOURCES.includes(row.source) ? row.source : 'admin', seconds: row.seconds, note: row.note, created_at: row.created_at, code_hash: hash, code_hint: hash ? row.note.slice(-4) : null, reason: row.reason || '', actor: row.actor || null } });
      }
      for (const session of this.sql.exec('SELECT * FROM sessions WHERE settled = 1').toArray()) this.enqueue(...this.sessionOps(session));
      this.enqueue({ type: 'summary' });
      this.setMeta('mirror_version', MIRROR_VERSION);
    });
    await this.mirror();
    return { pending: this.pendingMirror() };
  }

  // ---- admin: manual adjustment (authoritative here, then mirrored) ----
  async adjust({ seconds, reason, actor }) {
    if (!this.meta('id')) fail(404, 'USER_NOT_FOUND', '找不到这个用户');
    if (!Number.isSafeInteger(seconds) || seconds === 0) fail(400, 'BAD_AMOUNT', '请填写要加或减的分钟数');
    if (!String(reason || '').trim()) fail(400, 'REASON_REQUIRED', '请填写原因');
    const remaining = this.account().remainingSeconds;
    if (remaining + seconds < 0) fail(400, 'BELOW_ZERO', `不能减到 0 以下：这个用户现在只剩 ${minutesText(remaining)}`);
    this.ctx.storage.transactionSync(() => {
      const ref = 'admin:' + crypto.randomUUID();
      const id = this.addPurchase({ source: 'admin', ref, seconds, note: '后台调整', extra: { reason, actor } });
      this.sql.exec('INSERT INTO adjustments (purchase_id, reason, actor) VALUES (?, ?, ?)', id, reason, actor);
      this.enqueue({ type: 'audit', row: { at: this.now(), actor, action: 'adjust', target: this.meta('id'), detail: { minutes: seconds / 60, balanceAfterSeconds: this.totals().balance }, reason, ref } });
    });
    await this.mirror();
    return { account: this.account(), pendingMirror: this.pendingMirror() };
  }

  // ---- redeem codes ----
  async redeem({ code }) {
    const lockedUntil = Number(this.meta('redeem_locked_until') || 0);
    if (lockedUntil > this.now()) fail(429, 'REDEEM_LOCKED', `输错次数过多，请 ${Math.ceil((lockedUntil - this.now()) / 60000)} 分钟后再试`);
    const normalized = normalizeCode(code);
    let row = null, hash = null;
    if (normalized.length >= 12 && normalized.length <= 32) {
      hash = await hashCode(normalized);
      row = await this.env.DB.prepare('UPDATE redeem_codes SET redeemed_by = ?, redeemed_at = ? WHERE code_hash = ? AND redeemed_by IS NULL AND voided_at IS NULL AND (expires_at IS NULL OR expires_at > ?) RETURNING code_hash, credits, batch')
        .bind(this.meta('id'), this.now(), hash, this.now()).first();
    }
    if (!row) {
      // Only after the atomic update missed: say why, if the code exists.
      const known = hash ? await this.env.DB.prepare('SELECT redeemed_by, voided_at, expires_at FROM redeem_codes WHERE code_hash = ?').bind(hash).first() : null;
      const [code, message] = !known ? ['REDEEM_INVALID', '兑换码无效，请检查有没有输错']
        : known.redeemed_by ? ['REDEEM_INVALID', '这个兑换码已经被使用过了']
        : known.voided_at ? ['REDEEM_VOIDED', '这个兑换码已作废，不能再使用']
        : ['REDEEM_EXPIRED', '这个兑换码已过期，不能再使用'];
      const failures = Number(this.meta('redeem_failures') || 0) + 1;
      if (failures >= REDEEM_MAX_FAILURES) { this.setMeta('redeem_failures', 0); this.setMeta('redeem_locked_until', this.now() + REDEEM_LOCK_MS); }
      else this.setMeta('redeem_failures', failures);
      fail(400, code, failures >= REDEEM_MAX_FAILURES ? `${message.replace(/[。.]$/, '')}。输错次数过多，请 15 分钟后再试` : message);
    }
    this.setMeta('redeem_failures', 0);
    const ref = 'code:' + row.code_hash;
    if (!this.sql.exec('SELECT 1 FROM purchases WHERE ref = ?', ref).toArray().length) {
      this.ctx.storage.transactionSync(() => this.addPurchase({ source: 'redeem', ref, seconds: row.credits * 60, note: '兑换码 …' + normalized.slice(-4), extra: { code_hash: row.code_hash, code_hint: normalized.slice(-4), batch: row.batch } }));
      await this.mirror();
    }
    return { credits: row.credits, account: this.account() };
  }
}
export { ServiceError };
