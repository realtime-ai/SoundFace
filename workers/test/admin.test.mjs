// Admin console API, end to end against a real local `wrangler dev` (workerd,
// local D1, Durable Objects). Fake provider only: no network, no cost.
// The tests in this file share one worker and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, IMAGE, sleep } from './harness.mjs';
import { beijingDay } from '../src/days.js';
import { adminPagePath } from '../src/pages.js';

const ADMIN = 'boss@example.com';
let w, admin;
const call = (...a) => w.call(...a), ok = (...a) => w.ok(...a);
const as = token => ({
  get: route => ok('GET', route, null, token), post: (route, body) => ok('POST', route, body, token),
  call: (method, route, body) => call(method, route, body, token)
});
let n = 0; const fresh = async prefix => (await w.login(`${prefix}${++n}@example.com`)).token; // one account per rejection group (redeem lock)

before(async () => {
  // A phone number in the list must still be rejected: only email accounts can be admins.
  w = await startWorker({ ADMIN_EMAILS: ` ${ADMIN.toUpperCase()} , second@example.com,13800138000`, TRIAL_SECONDS: '600', MIN_START_SECONDS: '1', MIRROR_RETRY_MS: '300' });
  admin = as((await w.login(ADMIN)).token);
}, { timeout: 120000 });
after(() => w?.stop());

// Independent of src/days.js: Beijing date via the platform's time zone database.
const shanghai = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
async function runSession(token, { frameMs = 0 } = {}) {
  const live = await ok('POST', '/v1/sessions', { image: IMAGE }, token);
  if (frameMs) { await ok('POST', `/v1/sessions/${live.sessionId}/heartbeat`, { frames: 1 }, token); await sleep(frameMs); }
  const done = await ok('POST', `/v1/sessions/${live.sessionId}/hangup`, null, token);
  assert.equal(done.state, 'ended');
  return done.billedSeconds;
}

test('permissions: no login 401, bad token 401, normal / phone / unlisted accounts 403, listed email (any case) 200', async () => {
  const routes = [['GET', '/admin/v1/me'], ['GET', '/admin/v1/overview'], ['GET', '/admin/v1/batches'], ['GET', '/admin/v1/users'], ['GET', '/admin/v1/usage'], ['GET', '/admin/v1/audit'],
    ['POST', '/admin/v1/batches', { plan: 'starter', count: 1 }], ['POST', '/admin/v1/users/email%3Aboss%40example.com/adjust', { minutes: 100, reason: 'x' }], ['POST', '/admin/v1/backfill']];
  const normal = await fresh('normal'); // ordinary app user, not listed
  await ok('POST', '/v1/auth/sms/code', { phone: '13800138000' });
  const phone = (await ok('POST', '/v1/auth/sms/login', { phone: '13800138000', code: '000000' })).token;
  const dev = (await ok('POST', '/v1/auth/dev/login', { name: 'boss' })).token;
  for (const [method, route, body] of routes) {
    assert.equal((await call(method, route, body)).status, 401, `${route} without login`);
    assert.equal((await call(method, route, body, 'not-a-token')).status, 401, `${route} bad token`);
    for (const [who, token] of [['normal', normal], ['phone', phone], ['dev', dev]]) {
      const result = await call(method, route, body, token);
      assert.equal(result.status, 403, `${route} as ${who}`); assert.equal(result.body.code, 'NOT_ADMIN');
      assert.match(result.body.message, /没有管理后台的权限/);
    }
  }
  assert.equal((await admin.get('/admin/v1/batches')).batches.length, 0, 'rejected POSTs created nothing');
  assert.equal((await admin.get('/admin/v1/me')).email, ADMIN);
  const second = as((await w.login('Second@Example.com')).token);
  assert.equal((await second.get('/admin/v1/me')).email, 'second@example.com');
  for (const [method, route] of routes.filter(([method]) => method === 'GET')) assert.equal((await admin.call(method, route)).status, 200, route);
});

test('admin page is served at /admin/ (and / on the admin host) with a strict CSP; the API host root is not', async () => {
  const page = await fetch(w.base + '/admin/');
  assert.equal(page.status, 200); assert.match(await page.text(), /<html/i);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(w.base + '/admin', { redirect: 'manual' })).headers.get('location'), w.base + '/admin/');
  assert.equal((await fetch(w.base + '/admin/app.js')).status, 200);
  assert.equal((await fetch(w.base + '/admin/nope.js')).status, 404);
  assert.equal((await fetch(w.base + '/')).status, 404);
  assert.equal((await fetch(w.base + '/app.js')).status, 404, 'assets are not exposed on the API host');
  // Host routing (wrangler dev rewrites the Host header, so checked directly).
  const path = (href, env = {}) => adminPagePath(new URL(href), env);
  assert.equal(path('https://admin.soundface.dot.cc/'), '/'); assert.equal(path('https://admin.soundface.dot.cc/app.js'), '/app.js');
  assert.equal(path('https://admin.soundface.dot.cc/admin/app.js'), '/app.js');
  assert.equal(path('https://admin.soundface.dot.cc/v1/auth/email/code'), null, 'the app API also works on the admin host');
  assert.equal(path('https://admin.soundface.dot.cc/admin/v1/overview'), null);
  assert.equal(path('https://soundface-api.dot.cc/'), null); assert.equal(path('https://soundface-api.dot.cc/app.js'), null);
  assert.equal(path('https://soundface-api.dot.cc/admin/'), '/'); assert.equal(path('https://soundface-api.dot.cc/administrator'), null);
  assert.equal(path('https://other.example/', { ADMIN_HOST: 'other.example' }), '/');
});

let starterBatch, starterCodes;
test('generate a batch: count, minutes, expiry, note; codes redeem in the app; plaintext is returned only once', async () => {
  const before = Date.now();
  const created = await admin.post('/admin/v1/batches', { plan: 'regular', count: 7, note: '11 月内测', expiresOn: '2099-12-31' });
  assert.equal(created.codes.length, 7); assert.equal(new Set(created.codes).size, 7);
  for (const code of created.codes) assert.match(code, /^SF-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  assert.equal(created.batch.minutes, 520); assert.equal(created.batch.note, '11 月内测'); assert.equal(created.batch.total, 7);
  assert.equal(created.batch.expiresAt, Date.parse('2100-01-01T00:00:00+08:00'), 'valid through the whole Beijing day');
  assert.ok(created.batch.createdAt >= before);
  const custom = await admin.post('/admin/v1/batches', { minutes: 45, count: 3 });
  assert.equal(custom.batch.minutes, 45); assert.equal(custom.batch.expiresAt, null); assert.equal(custom.batch.note, '');
  starterBatch = custom.batch.id; starterCodes = custom.codes;

  const list = (await admin.get('/admin/v1/batches')).batches;
  const listed = list.find(item => item.id === created.batch.id);
  assert.deepEqual([listed.total, listed.minutes, listed.note, listed.unused, listed.redeemed, listed.voided], [7, 520, '11 月内测', 7, 0, 0]);
  const detail = await admin.get(`/admin/v1/batches/${created.batch.id}`);
  assert.equal(detail.codes.length, 7);
  assert.deepEqual(detail.codes.map(code => code.hint).sort(), created.codes.map(code => code.slice(-4)).sort());
  // Plaintext never comes back: not in the list, the detail, or a lookup.
  const everything = JSON.stringify([list, detail, await admin.get('/admin/v1/codes?q=' + encodeURIComponent(created.codes[0]))]);
  for (const code of created.codes) { assert.ok(!everything.includes(code)); assert.ok(!everything.includes(code.replace(/^SF-/, '').replace(/-/g, ''))); }

  const user = await fresh('buyer');
  const redeemed = await ok('POST', '/v1/redeem', { code: created.codes[0].toLowerCase() }, user);
  assert.equal(redeemed.credits, 520); assert.equal(redeemed.account.remainingSeconds, 600 + 520 * 60);
  const after = (await admin.get(`/admin/v1/batches/${created.batch.id}`)).codes.find(code => code.hint === created.codes[0].slice(-4));
  assert.equal(after.status, 'redeemed'); assert.equal(after.redeemedBy, `email:buyer${n}@example.com`); assert.ok(after.redeemedAt >= before);
  const found = (await admin.get('/admin/v1/codes?q=' + created.codes[0].slice(-4))).codes;
  assert.ok(found.some(code => code.status === 'redeemed' && code.batch === created.batch.id));

  for (const [body, code] of [[{ plan: 'regular', count: 501 }, 'BAD_COUNT'], [{ plan: 'regular', count: 0 }, 'BAD_COUNT'], [{ minutes: 0, count: 1 }, 'BAD_MINUTES'],
    [{ minutes: 1.5, count: 1 }, 'BAD_MINUTES'], [{ plan: 'nope', count: 1 }, 'BAD_PLAN'], [{ minutes: 10, count: 1, expiresOn: '2020-01-01' }, 'BAD_EXPIRY'], [{ minutes: 10, count: 1, expiresOn: '2026-02-30' }, 'BAD_EXPIRY']]) {
    const result = await admin.call('POST', '/admin/v1/batches', body);
    assert.equal(result.status, 400, JSON.stringify(body)); assert.equal(result.body.code, code);
  }
  assert.equal((await admin.call('GET', '/admin/v1/codes?q=12')).status, 400);
  const max = await admin.post('/admin/v1/batches', { minutes: 1, count: 500, note: '上限' });
  assert.equal(max.codes.length, 500);
  assert.equal((await admin.get(`/admin/v1/batches/${max.batch.id}`)).codes.length, 500);
});

test('void: a voided code fails with a clear message; redeemed codes are untouched; batch void only touches unused codes', async () => {
  const [first, second, third] = starterCodes, owner = await fresh('owner');
  await ok('POST', '/v1/redeem', { code: first }, owner);
  const codes = (await admin.get(`/admin/v1/batches/${starterBatch}`)).codes, id = code => codes.find(item => item.hint === code.slice(-4)).id;
  const voided = await admin.post(`/admin/v1/codes/${id(second)}/void`, { reason: '发错人了' });
  assert.equal(voided.code.status, 'voided'); assert.equal(voided.code.voidedBy, ADMIN);
  const tryUser = await fresh('try');
  const refused = await call('POST', '/v1/redeem', { code: second }, tryUser);
  assert.equal(refused.status, 400); assert.equal(refused.body.code, 'REDEEM_VOIDED'); assert.equal(refused.body.message, '这个兑换码已作废，不能再使用');
  const redeemedVoid = await admin.call('POST', `/admin/v1/codes/${id(first)}/void`, {});
  assert.equal(redeemedVoid.status, 409); assert.match(redeemedVoid.body.message, /已经被兑换/);
  assert.equal((await admin.call('POST', `/admin/v1/codes/${id(second)}/void`, {})).status, 409, 'already voided');

  const batch = await admin.post(`/admin/v1/batches/${starterBatch}/void`, { reason: '整批收回' });
  assert.equal(batch.voided, 1, 'only the one unused code');
  const statuses = (await admin.get(`/admin/v1/batches/${starterBatch}`)).codes.map(code => code.status).sort();
  assert.deepEqual(statuses, ['redeemed', 'voided', 'voided']);
  assert.equal((await call('POST', '/v1/redeem', { code: third }, tryUser)).body.code, 'REDEEM_VOIDED');
  assert.equal((await ok('GET', '/v1/me', null, owner)).remainingSeconds, 600 + 45 * 60, 'redeemed balance unaffected');
  assert.equal((await admin.call('POST', `/admin/v1/batches/${starterBatch}/void`, {})).status, 409, 'nothing left to void');
  const listed = (await admin.get('/admin/v1/batches')).batches.find(item => item.id === starterBatch);
  assert.deepEqual([listed.redeemed, listed.voided, listed.unused], [1, 2, 0]);
});

test('expiry: an expired code fails with a clear message and shows as 已过期 (expired)', async () => {
  const created = await admin.post('/admin/v1/batches', { minutes: 10, count: 2, expiresOn: beijingDay(Date.now()) });
  const user = await fresh('late');
  await ok('POST', '/v1/redeem', { code: created.codes[0] }, user); // still valid today
  w.d1(`UPDATE redeem_codes SET expires_at = ${Date.now() - 1000} WHERE batch = '${created.batch.id}'`); // time passes
  const refused = await call('POST', '/v1/redeem', { code: created.codes[1] }, user);
  assert.equal(refused.body.code, 'REDEEM_EXPIRED'); assert.equal(refused.body.message, '这个兑换码已过期，不能再使用');
  const statuses = Object.fromEntries((await admin.get(`/admin/v1/batches/${created.batch.id}`)).codes.map(code => [code.hint, code.status]));
  assert.equal(statuses[created.codes[0].slice(-4)], 'redeemed', 'a redeemed code stays redeemed after its expiry');
  assert.equal(statuses[created.codes[1].slice(-4)], 'expired');
  assert.equal((await admin.get('/admin/v1/codes?q=' + created.codes[1])).codes[0].status, 'expired');
  const listed = (await admin.get('/admin/v1/batches')).batches.find(item => item.id === created.batch.id);
  assert.deepEqual([listed.expired, listed.redeemed, listed.unused], [1, 1, 0]);
  assert.equal((await call('POST', '/v1/redeem', { code: 'SF-0000-0000-0000-0000' }, await fresh('typo'))).body.message, '兑换码无效，请检查有没有输错');
});

test('manual adjustment: through the account, shows as 后台调整 with reason, cannot go below zero, reason required', async () => {
  const token = await fresh('adjust'), id = `email:adjust${n}@example.com`, route = `/admin/v1/users/${encodeURIComponent(id)}/adjust`;
  const added = await admin.post(route, { minutes: 30, reason: '直播卡顿补偿' });
  assert.equal(added.account.remainingSeconds, 600 + 1800); assert.equal(added.pendingMirror, 0);
  assert.equal((await ok('GET', '/v1/me', null, token)).remainingSeconds, 2400, 'the app sees it');
  const history = await ok('GET', '/v1/history', null, token);
  assert.deepEqual(history.purchases.find(item => item.source === 'admin'), { source: 'admin', credits: 30, note: '后台调整', at: history.purchases[0].at });

  const below = await admin.call('POST', route, { minutes: -41, reason: '纠错' });
  assert.equal(below.status, 400); assert.equal(below.body.code, 'BELOW_ZERO'); assert.match(below.body.message, /不能减到 0 以下.*40 分钟/);
  for (const [body, code] of [[{ minutes: -5 }, 'REASON_REQUIRED'], [{ minutes: -5, reason: '   ' }, 'REASON_REQUIRED'], [{ minutes: 0, reason: 'x' }, 'BAD_AMOUNT'], [{ minutes: 1.5, reason: 'x' }, 'BAD_AMOUNT'], [{ minutes: 'abc', reason: 'x' }, 'BAD_AMOUNT']]) {
    const result = await admin.call('POST', route, body);
    assert.equal(result.status, 400, JSON.stringify(body)); assert.equal(result.body.code, code);
  }
  assert.equal((await admin.call('POST', `/admin/v1/users/${encodeURIComponent('email:ghost@example.com')}/adjust`, { minutes: 5, reason: 'x' })).status, 404);
  assert.equal((await ok('GET', '/v1/me', null, token)).remainingSeconds, 2400, 'rejected adjustments changed nothing');

  const toZero = await admin.post(route, { minutes: -40, reason: '纠错：多加了' });
  assert.equal(toZero.account.remainingSeconds, 0);
  const detail = await admin.get(`/admin/v1/users/${encodeURIComponent(id)}`);
  assert.equal(detail.user.balanceSeconds, 0); assert.equal(detail.user.rechargedSeconds, 0, '累计充值 is net of adjustments');
  const adjustments = detail.recharges.filter(item => item.kind === 'admin');
  assert.deepEqual(adjustments.map(item => [item.seconds, item.reason, item.actor, item.note]), [[-2400, '纠错：多加了', ADMIN, '后台调整'], [1800, '直播卡顿补偿', ADMIN, '后台调整']]);
  assert.ok(detail.recharges.some(item => item.kind === 'trial' && item.seconds === 600));
});

test('statistics: sessions across users; overview, daily table and user totals match what happened', async () => {
  const now = Date.now(), today = shanghai(now), yesterday = shanghai(now - 86400000);
  const alice = await fresh('alice'), bob = await fresh('bob'), aliceId = `email:alice${n - 1}@example.com`, bobId = `email:bob${n}@example.com`;
  const a1 = await runSession(alice, { frameMs: 2200 });
  const a2 = await runSession(alice);                   // no frame: counted as a session, costs nothing
  const b1 = await runSession(bob, { frameMs: 1200 });
  assert.equal(a2, 0); assert.ok(a1 >= 2 && b1 >= 1, `${a1} ${b1}`);
  // Yesterday (Beijing) for another user, written as the mirror would have.
  const yAt = Date.parse(yesterday + 'T12:00:00+08:00');
  w.d1(`INSERT INTO session_records (id, account_id, created_at, first_frame_at, ended_at, billed_seconds, had_frame, day) VALUES ('seed-y', 'email:old@example.com', ${yAt}, ${yAt + 1000}, ${yAt + 601000}, 600, 1, '${yesterday}')`);

  const overview = await admin.get('/admin/v1/overview');
  assert.equal(overview.today, today);
  const users = await admin.get('/admin/v1/users?sort=created');
  assert.deepEqual(overview.periods.today, { from: today, to: today, newUsers: users.total, activeUsers: 2, usedSeconds: a1 + b1,
    redeemedSeconds: (await admin.get('/admin/v1/batches')).batches.reduce((sum, batch) => sum + batch.redeemed * batch.minutes * 60, 0) });
  assert.equal(overview.periods.yesterday.usedSeconds, 600); assert.equal(overview.periods.yesterday.activeUsers, 1);
  assert.equal(overview.periods.days7.usedSeconds, a1 + b1 + 600); assert.equal(overview.periods.days7.activeUsers, 3);
  assert.equal(overview.periods.days30.usedSeconds, a1 + b1 + 600);
  assert.equal(overview.daily.length, 30); assert.equal(overview.daily.at(-1).day, today);
  assert.equal(overview.daily.at(-1).usedSeconds, a1 + b1); assert.equal(overview.daily.at(-2).usedSeconds, 600);

  const usage = await admin.get(`/admin/v1/usage?from=${yesterday}&to=${today}`);
  assert.deepEqual(usage.days[0], { day: today, users: 2, sessions: 3, totalSeconds: a1 + b1, noFrameSessions: 1, averageSeconds: Math.round((a1 + b1) / 2) });
  assert.deepEqual(usage.days[1], { day: yesterday, users: 1, sessions: 1, totalSeconds: 600, noFrameSessions: 0, averageSeconds: 600 });
  assert.equal(usage.total.sessions, 4); assert.equal(usage.total.users, 3);

  const aliceDetail = await admin.get(`/admin/v1/users/${encodeURIComponent(aliceId)}`);
  assert.equal(aliceDetail.user.usedSeconds, a1); assert.equal(aliceDetail.user.balanceSeconds, 600 - a1);
  assert.equal(aliceDetail.user.balanceSeconds, (await ok('GET', '/v1/me', null, alice)).remainingSeconds, 'D1 summary equals the account');
  assert.deepEqual(aliceDetail.sessions.map(item => [item.billedSeconds, item.hadFrame, item.day]), [[0, false, today], [a1, true, today]]);
  assert.ok(aliceDetail.user.lastUsedAt >= now);
  const byUsed = (await admin.get('/admin/v1/users?sort=used&dir=desc')).users;
  assert.equal(byUsed[0].id, a1 >= b1 ? aliceId : bobId);
  assert.deepEqual((await admin.get('/admin/v1/users?q=' + encodeURIComponent(`bob${n}@`))).users.map(item => item.id), [bobId]);
  const byBalance = (await admin.get('/admin/v1/users?sort=balance&dir=asc')).users.map(item => item.balanceSeconds);
  assert.deepEqual(byBalance, [...byBalance].sort((x, y) => x - y));
});

test('statistics: a session from 23:50 to 00:10 Beijing time counts entirely on the day it started', async () => {
  // Rows as the mirror writes them; the expected dates are written out by hand.
  const start = Date.parse('2026-10-01T23:50:00+08:00'), end = Date.parse('2026-10-02T00:10:00+08:00');
  assert.equal(beijingDay(start), '2026-10-01'); assert.equal(beijingDay(end), '2026-10-02');
  assert.equal(beijingDay(Date.parse('2026-10-01T16:00:00Z')), '2026-10-02', 'UTC 16:00 is Beijing midnight');
  w.d1(`INSERT INTO session_records (id, account_id, created_at, first_frame_at, ended_at, billed_seconds, had_frame, day) VALUES
    ('seed-midnight', 'email:night@example.com', ${start}, ${start + 5000}, ${end}, 1195, 1, '${beijingDay(start)}'),
    ('seed-noframe', 'email:night@example.com', ${end + 60000}, NULL, ${end + 90000}, 0, 0, '${beijingDay(end + 60000)}')`);
  const usage = await admin.get('/admin/v1/usage?from=2026-09-30&to=2026-10-02');
  assert.deepEqual(usage.days.map(day => [day.day, day.sessions, day.totalSeconds, day.noFrameSessions]),
    [['2026-10-02', 1, 0, 1], ['2026-10-01', 1, 1195, 0], ['2026-09-30', 0, 0, 0]]);
  assert.equal((await admin.call('GET', '/admin/v1/usage?from=2026-10-02&to=2026-10-01')).status, 400);
  assert.equal((await admin.call('GET', '/admin/v1/usage?from=2020-01-01&to=2026-10-01')).status, 400);
});

test('D1 outage: the account keeps the change in its outbox and the alarm writes it once D1 is back', async () => {
  const token = await fresh('outage'), id = `email:outage${n}@example.com`;
  w.d1('ALTER TABLE balance_ledger RENAME TO balance_ledger_down');
  let adjusted;
  try { adjusted = await admin.post(`/admin/v1/users/${encodeURIComponent(id)}/adjust`, { minutes: 7, reason: '断线测试' }); }
  finally { w.d1('ALTER TABLE balance_ledger_down RENAME TO balance_ledger'); }
  assert.equal(adjusted.account.remainingSeconds, 600 + 420, 'the account itself changed immediately');
  assert.ok(adjusted.pendingMirror > 0, 'mirror is pending');
  assert.equal((await ok('GET', '/v1/me', null, token)).remainingSeconds, 1020);
  let detail;
  for (let i = 0; i < 40; i++) {
    detail = await admin.get(`/admin/v1/users/${encodeURIComponent(id)}`);
    if (detail.recharges.some(item => item.kind === 'admin')) break;
    await sleep(500);
  }
  assert.ok(detail.recharges.some(item => item.kind === 'admin' && item.seconds === 420 && item.reason === '断线测试'), 'retried by the alarm');
  assert.equal(detail.user.balanceSeconds, 1020);
  assert.equal(w.query(`SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'adjust' AND target = '${id}'`)[0].n, 1, 'audit entry written exactly once');
});

test('backfill: accounts whose D1 rows are missing are rebuilt from their Durable Object', async () => {
  const token = await fresh('legacy'), id = `email:legacy${n}@example.com`;
  await runSession(token, { frameMs: 1100 });
  w.d1(`DELETE FROM user_summary WHERE account_id = '${id}'; DELETE FROM balance_ledger WHERE account_id = '${id}'; DELETE FROM session_records WHERE account_id = '${id}'`);
  assert.equal((await admin.get(`/admin/v1/users/${encodeURIComponent(id)}`)).user.synced, false);
  const result = await admin.post('/admin/v1/backfill');
  assert.ok(result.accounts >= 10); assert.equal(result.pending, 0);
  const detail = await admin.get(`/admin/v1/users/${encodeURIComponent(id)}`);
  assert.equal(detail.user.synced, true); assert.equal(detail.user.balanceSeconds, (await ok('GET', '/v1/me', null, token)).remainingSeconds);
  assert.equal(detail.sessions.length, 1); assert.ok(detail.recharges.some(item => item.kind === 'trial'));
});

test('audit log: every operation is recorded with actor, target and reason; the log is read-only', async () => {
  const entries = (await admin.get('/admin/v1/audit')).entries;
  const find = (action, predicate = () => true) => entries.find(entry => entry.action === action && predicate(entry));
  assert.ok(find('batch_create', entry => entry.detail.note === '11 月内测' && entry.detail.count === 7 && entry.actor === ADMIN));
  assert.ok(find('code_void', entry => entry.reason === '发错人了' && entry.target.startsWith(starterBatch) && entry.actor === ADMIN));
  assert.ok(find('batch_void', entry => entry.reason === '整批收回' && entry.target === starterBatch && entry.detail.count === 1));
  assert.ok(find('adjust', entry => entry.reason === '直播卡顿补偿' && entry.detail.minutes === 30 && entry.target.startsWith('email:adjust')));
  assert.ok(find('adjust', entry => entry.reason === '纠错：多加了' && entry.detail.minutes === -40));
  assert.ok(find('backfill', entry => entry.actor === ADMIN));
  assert.ok(!find('adjust', entry => entry.reason === '纠错' && entry.detail.minutes === -41), 'rejected operations leave no entry');
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await admin.call(method, '/admin/v1/audit')).status, 404);
  const normal = await fresh('peek');
  assert.equal((await call('GET', '/admin/v1/audit', null, normal)).status, 403);
});


test('invalid calendar dates return 400 rather than an internal error', async () => {
  for (const day of ['2026-13-01', '2026-02-30', '2026-00-01']) {
    assert.equal((await admin.call('GET', `/admin/v1/usage?from=${day}&to=${day}`)).status, 400);
    assert.equal((await admin.call('POST', '/admin/v1/batches', { minutes: 1, count: 1, expiresOn: day })).status, 400);
  }
});

test('voiding rolls back when the audit write fails, for one code and a whole batch', async () => {
  const created = await admin.post('/admin/v1/batches', { minutes: 10, count: 2 });
  const { codes } = await admin.get(`/admin/v1/batches/${created.batch.id}`);
  w.d1('ALTER TABLE admin_audit RENAME TO audit_unavailable');
  try {
    assert.equal((await admin.call('POST', `/admin/v1/codes/${codes[0].id}/void`, {})).status, 500);
    assert.equal((await admin.call('POST', `/admin/v1/batches/${created.batch.id}/void`, {})).status, 500);
    assert.ok((await admin.get(`/admin/v1/batches/${created.batch.id}`)).codes.every(code => code.status === 'unused'));
  } finally { w.d1('ALTER TABLE audit_unavailable RENAME TO admin_audit'); }
});
