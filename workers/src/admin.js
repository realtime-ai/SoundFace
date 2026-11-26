// Admin console API, /admin/v1/... Every request is checked against the
// ADMIN_EMAILS allowlist (src/auth.js); hiding UI is never the protection.
// Reads come from the D1 summary tables only (mirrored by each account's DO).
// Writes that touch a balance go through the account's DO, which stays
// authoritative. All "day" values are Beijing dates (see src/days.js).
//
//   GET  me                              → { email }
//   GET  overview                        → { today, periods, daily }
//   GET  plans                           → { plans }
//   GET  batches | POST batches          → list | { batch, codes (plaintext, ONCE) }
//   GET  batches/:id                     → { batch, codes }
//   POST batches/:id/void   { reason }   → { voided }
//   GET  codes?q=<code or last 4>        → { codes }
//   POST codes/:hash/void   { reason }   → { code }
//   GET  users?q=&sort=&dir=&offset=     → { users, total }
//   GET  users/:id                       → { user, ledger, sessions }
//   POST users/:id/adjust   { minutes, reason } → { account }
//   GET  usage?from=&to=                 → { days, total }
//   GET  audit?offset=                   → { entries }
//   POST backfill                        → { accounts }   (resend every DO's history to D1)
import { fail, readJson } from './util.js';
import { authenticateAdmin } from './auth.js';
import { PLANS } from './plans.js';
import { generateCodes, normalizeCode, hashCode, codeStatus } from './codes.js';
import { beijingDay, isDay, dayStart, addDays, daysBetween } from './days.js';

const MAX_BATCH = 500, MAX_MINUTES = 100000, PAGE = 50, DAY_MS = 86400000;
const text = (value, max) => String(value ?? '').trim().slice(0, max);
const all = async statement => (await statement.all()).results;

async function audit(env, { actor, action, target, detail = {}, reason = '' }) {
  return env.DB.prepare('INSERT INTO admin_audit (at, actor, action, target, detail, reason) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(Date.now(), actor, action, target, JSON.stringify(detail), reason);
}
const codeView = (row, now) => ({
  id: row.code_hash, hint: row.hint, batch: row.batch, note: row.note, minutes: row.credits, createdAt: row.created_at, expiresAt: row.expires_at,
  status: codeStatus(row, now), redeemedBy: row.redeemed_by, redeemedAt: row.redeemed_at, voidedAt: row.voided_at, voidedBy: row.voided_by
});
const BATCH_COLUMNS = `batch, MIN(created_at) AS created_at, MAX(note) AS note, MAX(credits) AS credits, MAX(expires_at) AS expires_at, COUNT(*) AS total,
  SUM(redeemed_by IS NOT NULL) AS redeemed, SUM(redeemed_by IS NULL AND voided_at IS NOT NULL) AS voided,
  SUM(redeemed_by IS NULL AND voided_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?1) AS expired`;
const batchView = row => ({ id: row.batch, createdAt: row.created_at, note: row.note, minutes: row.credits, expiresAt: row.expires_at, total: row.total,
  redeemed: row.redeemed, voided: row.voided, expired: row.expired, unused: row.total - row.redeemed - row.voided - row.expired });

// ---- overview ----
async function overview(env, now) {
  const today = beijingDay(now), yesterday = addDays(today, -1), from7 = addDays(today, -6), from30 = addDays(today, -29);
  const ranges = { today: [today, today], yesterday: [yesterday, yesterday], days7: [from7, today], days30: [from30, today] };
  const per = (expr, [from, to]) => `${expr.replace('$IN', `day BETWEEN '${from}' AND '${to}'`)}`;
  const parts = Object.entries(ranges);
  const [users, sessions, redeemed, daily] = await env.DB.batch([
    env.DB.prepare(`SELECT ${parts.map(([key, [from, to]]) => `SUM(created_at >= ${dayStart(from)} AND created_at < ${dayStart(to) + DAY_MS}) AS ${key}`).join(', ')} FROM users WHERE created_at >= ?`).bind(dayStart(from30)),
    env.DB.prepare(`SELECT ${parts.map(([key, range]) => `COUNT(DISTINCT CASE WHEN ${per('$IN', range)} THEN account_id END) AS ${key}_users, SUM(CASE WHEN ${per('$IN', range)} THEN billed_seconds ELSE 0 END) AS ${key}_seconds`).join(', ')} FROM session_records WHERE day >= ?`).bind(from30),
    env.DB.prepare(`SELECT ${parts.map(([key, range]) => `SUM(CASE WHEN ${per('$IN', range)} THEN seconds ELSE 0 END) AS ${key}`).join(', ')} FROM balance_ledger WHERE kind = 'redeem' AND day >= ?`).bind(from30),
    env.DB.prepare('SELECT day, SUM(billed_seconds) AS seconds, COUNT(*) AS sessions FROM session_records WHERE day BETWEEN ? AND ? GROUP BY day').bind(from30, today)
  ]);
  const [u, s, r] = [users.results[0], sessions.results[0], redeemed.results[0]];
  const periods = Object.fromEntries(parts.map(([key, [from, to]]) => [key, {
    from, to, newUsers: u[key] || 0, activeUsers: s[key + '_users'] || 0, usedSeconds: s[key + '_seconds'] || 0, redeemedSeconds: r[key] || 0
  }]));
  const byDay = new Map(daily.results.map(row => [row.day, row]));
  return { today, now, periods, daily: daysBetween(from30, today).map(day => ({ day, usedSeconds: byDay.get(day)?.seconds || 0, sessions: byDay.get(day)?.sessions || 0 })) };
}

// ---- redeem codes ----
async function createBatch(env, actor, body, now) {
  const plan = body.plan ? PLANS.find(item => item.id === body.plan) : null;
  if (body.plan && !plan) fail(400, 'BAD_PLAN', '没有这个套餐');
  const minutes = plan ? plan.credits : Number(body.minutes), count = Number(body.count);
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > MAX_MINUTES) fail(400, 'BAD_MINUTES', `每个码的分钟数要在 1 到 ${MAX_MINUTES} 之间`);
  if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_BATCH) fail(400, 'BAD_COUNT', `数量要在 1 到 ${MAX_BATCH} 之间`);
  let expiresAt = null;
  if (body.expiresOn) {
    if (!isDay(body.expiresOn)) fail(400, 'BAD_EXPIRY', '有效期日期格式不对');
    if (body.expiresOn < beijingDay(now)) fail(400, 'BAD_EXPIRY', '有效期不能早于今天');
    expiresAt = dayStart(body.expiresOn) + DAY_MS; // valid through the whole Beijing day
  }
  const note = text(body.note, 100) || plan?.name || '';
  const { batch, codes } = await generateCodes(count, now);
  // One statement for the whole batch (D1 limits bound parameters per query and queries per request).
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO redeem_codes (code_hash, hint, credits, batch, note, created_at, expires_at)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?, ?, ?, ?, ? FROM json_each(?)`)
      .bind(minutes, batch, note, now, expiresAt, JSON.stringify(codes.map(code => [code.hash, code.hint]))),
    await audit(env, { actor, action: 'batch_create', target: batch, detail: { count, minutes, plan: plan?.id || null, expiresAt, note } })
  ]);
  // The only time plaintext codes leave the server.
  return { batch: { id: batch, createdAt: now, note, minutes, expiresAt, total: count }, codes: codes.map(code => code.display) };
}
async function listBatches(env, now) {
  return { batches: (await all(env.DB.prepare(`SELECT ${BATCH_COLUMNS} FROM redeem_codes GROUP BY batch ORDER BY created_at DESC LIMIT 500`).bind(now))).map(batchView) };
}
async function batchDetail(env, id, now) {
  const [summary] = await all(env.DB.prepare(`SELECT ${BATCH_COLUMNS} FROM redeem_codes WHERE batch = ?2 GROUP BY batch`).bind(now, id));
  if (!summary) fail(404, 'BATCH_NOT_FOUND', '找不到这一批兑换码');
  const codes = await all(env.DB.prepare('SELECT * FROM redeem_codes WHERE batch = ? ORDER BY redeemed_at IS NULL, redeemed_at DESC, hint').bind(id));
  return { batch: batchView(summary), codes: codes.map(row => codeView(row, now)) };
}
async function voidBatch(env, actor, id, reason, now) {
  const [updated] = await env.DB.batch([
    env.DB.prepare('UPDATE redeem_codes SET voided_at = ?, voided_by = ? WHERE batch = ? AND redeemed_by IS NULL AND voided_at IS NULL RETURNING hint').bind(now, actor, id),
    // Keep the action and its audit entry in the same D1 transaction. changes()
    // refers to the UPDATE above, so unsuccessful attempts create no log.
    env.DB.prepare(`INSERT INTO admin_audit (at, actor, action, target, detail, reason)
      SELECT ?, ?, 'batch_void', ?, json_object('count', changes()), ? WHERE changes() > 0`).bind(now, actor, id, reason)
  ]);
  const voided = updated.results;
  if (!voided.length) fail(409, 'NOTHING_TO_VOID', '这一批没有还能作废的码（都已兑换或已作废）');
  return { voided: voided.length };
}
async function voidCode(env, actor, hash, reason, now) {
  const [updated] = await env.DB.batch([
    env.DB.prepare('UPDATE redeem_codes SET voided_at = ?, voided_by = ? WHERE code_hash = ? AND redeemed_by IS NULL AND voided_at IS NULL RETURNING *').bind(now, actor, hash),
    env.DB.prepare(`INSERT INTO admin_audit (at, actor, action, target, detail, reason)
      SELECT ?, ?, 'code_void', batch || ' …' || hint, json_object('batch', batch, 'hint', hint, 'minutes', credits), ?
      FROM redeem_codes WHERE code_hash = ? AND changes() > 0`).bind(now, actor, reason, hash)
  ]);
  const [row] = updated.results;
  if (!row) {
    const existing = await env.DB.prepare('SELECT * FROM redeem_codes WHERE code_hash = ?').bind(hash).first();
    if (!existing) fail(404, 'CODE_NOT_FOUND', '找不到这个兑换码');
    fail(409, 'CANNOT_VOID', existing.redeemed_by ? '这个码已经被兑换了，不能作废' : '这个码已经作废了');
  }
  return { code: codeView(row, now) };
}
async function findCodes(env, query, now) {
  const normalized = normalizeCode(query);
  let rows;
  if (normalized.length === 4) rows = await all(env.DB.prepare('SELECT * FROM redeem_codes WHERE hint = ? ORDER BY created_at DESC LIMIT 50').bind(normalized));
  else if (normalized.length >= 12 && normalized.length <= 32) rows = await all(env.DB.prepare('SELECT * FROM redeem_codes WHERE code_hash = ?').bind(await hashCode(normalized)));
  else fail(400, 'BAD_QUERY', '请输入完整的兑换码，或者它的最后 4 位');
  return { codes: rows.map(row => codeView(row, now)) };
}

// ---- users ----
const SORTS = { created: 'u.created_at', balance: 'COALESCE(s.balance_seconds, 0)', used: 'COALESCE(s.used_seconds, 0)' };
const userView = row => ({
  id: row.id, name: row.name, createdAt: row.created_at, synced: row.synced === 1,
  balanceSeconds: row.balance_seconds ?? 0, rechargedSeconds: row.recharged_seconds ?? 0, usedSeconds: row.used_seconds ?? 0, lastUsedAt: row.last_used_at ?? null
});
const USER_SELECT = `SELECT u.id, u.name, u.created_at, s.balance_seconds, s.recharged_seconds, s.used_seconds, s.last_used_at, s.account_id IS NOT NULL AS synced
  FROM users u LEFT JOIN user_summary s ON s.account_id = u.id`;
async function listUsers(env, params) {
  const sort = SORTS[params.get('sort')] || SORTS.created, dir = params.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const offset = Math.max(0, Number.parseInt(params.get('offset'), 10) || 0);
  const q = text(params.get('q'), 100).toLowerCase().replace(/[\\%_]/g, char => '\\' + char);
  const where = q ? `WHERE u.id LIKE ? ESCAPE '\\'` : '', args = q ? ['%' + q + '%'] : [];
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`${USER_SELECT} ${where} ORDER BY ${sort} ${dir}, u.created_at DESC LIMIT ${PAGE} OFFSET ${offset}`).bind(...args),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(...args)
  ]);
  return { users: rows.results.map(userView), total: count.results[0].n, offset, pageSize: PAGE };
}
async function userDetail(env, id) {
  const [users, ledger, sessions] = await env.DB.batch([
    env.DB.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(id),
    env.DB.prepare(`SELECT l.*, c.batch AS code_batch, c.hint AS hint FROM balance_ledger l LEFT JOIN redeem_codes c ON c.code_hash = l.code_hash
      WHERE l.account_id = ? AND l.kind != 'usage' ORDER BY l.created_at DESC LIMIT 500`).bind(id),
    env.DB.prepare('SELECT * FROM session_records WHERE account_id = ? ORDER BY created_at DESC LIMIT 500').bind(id)
  ]);
  if (!users.results.length) fail(404, 'USER_NOT_FOUND', '找不到这个用户');
  return {
    user: userView(users.results[0]),
    recharges: ledger.results.map(row => ({ id: row.id, kind: row.kind, seconds: row.seconds, codeHint: row.hint || row.code_hint, batch: row.code_batch || row.batch, note: row.note, reason: row.reason, actor: row.actor, at: row.created_at })),
    sessions: sessions.results.map(row => ({ id: row.id, startedAt: row.created_at, firstFrameAt: row.first_frame_at, endedAt: row.ended_at, billedSeconds: row.billed_seconds, hadFrame: row.had_frame === 1, endReason: row.end_reason, day: row.day }))
  };
}
async function adjustUser(env, actor, id, body) {
  const minutes = Number(body.minutes), reason = text(body.reason, 200);
  if (!Number.isSafeInteger(minutes) || minutes === 0 || Math.abs(minutes) > MAX_MINUTES) fail(400, 'BAD_AMOUNT', `请填写要加或减的分钟数（整数，最多 ${MAX_MINUTES}）`);
  if (!reason) fail(400, 'REASON_REQUIRED', '请填写原因');
  if (!(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(id).first())) fail(404, 'USER_NOT_FOUND', '找不到这个用户');
  const result = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id)).call('adjust', { seconds: minutes * 60, reason, actor });
  if (!result.ok) fail(result.status, result.code, result.message);
  return result.value;
}

// ---- usage ----
async function usage(env, params, now) {
  const to = params.get('to') || beijingDay(now), from = params.get('from') || addDays(to, -29);
  if (!isDay(from) || !isDay(to) || from > to) fail(400, 'BAD_RANGE', '日期范围不对');
  if (dayStart(to) - dayStart(from) > 366 * DAY_MS) fail(400, 'BAD_RANGE', '一次最多查一年');
  const [daily, total] = await env.DB.batch([
    env.DB.prepare(`SELECT day, COUNT(DISTINCT account_id) AS users, COUNT(*) AS sessions, SUM(billed_seconds) AS seconds, SUM(had_frame) AS framed
      FROM session_records WHERE day BETWEEN ? AND ? GROUP BY day`).bind(from, to),
    env.DB.prepare(`SELECT COUNT(DISTINCT account_id) AS users, COUNT(*) AS sessions, COALESCE(SUM(billed_seconds), 0) AS seconds, COALESCE(SUM(had_frame), 0) AS framed
      FROM session_records WHERE day BETWEEN ? AND ?`).bind(from, to)
  ]);
  const view = row => ({ users: row?.users || 0, sessions: row?.sessions || 0, totalSeconds: row?.seconds || 0, noFrameSessions: (row?.sessions || 0) - (row?.framed || 0),
    averageSeconds: row?.framed ? Math.round(row.seconds / row.framed) : 0 });
  const byDay = new Map(daily.results.map(row => [row.day, row]));
  return { from, to, days: daysBetween(from, to).reverse().map(day => ({ day, ...view(byDay.get(day)) })), total: view(total.results[0]) };
}

async function auditLog(env, params) {
  const offset = Math.max(0, Number.parseInt(params.get('offset'), 10) || 0);
  const rows = await all(env.DB.prepare(`SELECT * FROM admin_audit ORDER BY at DESC, id DESC LIMIT 100 OFFSET ${offset}`));
  return { entries: rows.map(row => ({ id: row.id, at: row.at, actor: row.actor, action: row.action, target: row.target, detail: JSON.parse(row.detail || '{}'), reason: row.reason })), offset };
}

// Resend every account's history from its DO (for accounts created before the mirror existed).
async function backfill(env, actor) {
  const users = await all(env.DB.prepare('SELECT id FROM users'));
  let pending = 0;
  for (const { id } of users) { const result = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id)).call('sync'); if (result.ok) pending += result.value.pending; }
  await (await audit(env, { actor, action: 'backfill', target: '全部用户', detail: { accounts: users.length, pending } })).run();
  return { accounts: users.length, pending };
}

export async function adminRoute(request, env, parts, url) {
  const actor = await authenticateAdmin(request, env), method = request.method, now = Date.now(), [head, id, action] = parts;
  const get = method === 'GET', post = method === 'POST';
  if (get && head === 'me' && parts.length === 1) return { email: actor };
  if (get && head === 'overview' && parts.length === 1) return overview(env, now);
  if (get && head === 'plans' && parts.length === 1) return { plans: PLANS, maxBatch: MAX_BATCH };
  if (head === 'batches') {
    if (parts.length === 1 && get) return listBatches(env, now);
    if (parts.length === 1 && post) return createBatch(env, actor, await readJson(request), now);
    if (parts.length === 2 && get) return batchDetail(env, decodeURIComponent(id), now);
    if (parts.length === 3 && post && action === 'void') return voidBatch(env, actor, decodeURIComponent(id), text((await readJson(request)).reason, 200), now);
  }
  if (head === 'codes') {
    if (parts.length === 1 && get) return findCodes(env, url.searchParams.get('q') || '', now);
    if (parts.length === 3 && post && action === 'void') return voidCode(env, actor, id, text((await readJson(request)).reason, 200), now);
  }
  if (head === 'users') {
    if (parts.length === 1 && get) return listUsers(env, url.searchParams);
    if (parts.length === 2 && get) return userDetail(env, decodeURIComponent(id));
    if (parts.length === 3 && post && action === 'adjust') return adjustUser(env, actor, decodeURIComponent(id), await readJson(request));
  }
  if (get && head === 'usage' && parts.length === 1) return usage(env, url.searchParams, now);
  if (get && head === 'audit' && parts.length === 1) return auditLog(env, url.searchParams);
  if (post && head === 'backfill' && parts.length === 1) return backfill(env, actor);
  fail(404, 'NOT_FOUND', '接口不存在');
}
