#!/usr/bin/env node
// Redeem-code tool for the owner. Codes are printed ONCE at creation; the
// database stores only their SHA-256 hash and the last 4 characters.
// Generation and hashing are shared with the admin console (src/codes.js).
//
//   npm run codes -- create --credits 99 --count 20 [--note 内测] [--expires-days 90] [--remote]
//   npm run codes -- create --plan regular --count 5 [--remote]      (plan ids: see src/plans.js)
//   npm run codes -- list [--batch <id>] [--remote]                  (status of every code)
//   npm run codes -- show SF-XXXX-XXXX-XXXX-XXXX [--remote]          (used? by whom? when?)
//
// Without --remote it works on the local `wrangler dev` database.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLANS } from '../src/plans.js';
import { generateCodes, normalizeCode, hashCode, codeStatus } from '../src/codes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...rest] = process.argv.slice(2);
const args = {}; for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { const key = rest[i].slice(2); args[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; } else (args._ ||= []).push(rest[i]); }
const where = args.remote ? '--remote' : '--local';
const die = message => { console.error(message); process.exit(1); };
const sqlString = value => `'${String(value).replace(/'/g, "''")}'`;
function d1(sqlText, json = false) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-codes-')), 'q.sql');
  fs.writeFileSync(file, sqlText);
  try { return execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', where, '--file', file, ...(json ? ['--json'] : [])], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); }
  finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
}
const rows = output => JSON.parse(output).flatMap(item => item.results || []);
const time = ms => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '');
const STATUS = { unused: '未用', redeemed: '已用', expired: '已过期', voided: '已作废' };

if (command === 'create') {
  const plan = args.plan ? PLANS.find(item => item.id === args.plan) : null;
  if (args.plan && !plan) die(`没有这个套餐：${args.plan}。可选：${PLANS.map(item => item.id).join(', ')}`);
  const credits = plan ? plan.credits : Number(args.credits), count = Number(args.count || 1);
  if (!Number.isSafeInteger(credits) || credits <= 0 || credits > 100000) die('--credits 必须是 1–100000 的整数（或用 --plan）');
  if (!Number.isSafeInteger(count) || count <= 0 || count > 1000) die('--count 必须是 1–1000 的整数');
  const now = Date.now(), { batch, codes } = await generateCodes(count, now);
  const expires = args['expires-days'] ? now + Number(args['expires-days']) * 86400000 : null;
  d1(codes.map(code => `INSERT INTO redeem_codes (code_hash, hint, credits, batch, note, created_at, expires_at) VALUES (${sqlString(code.hash)}, ${sqlString(code.hint)}, ${credits}, ${sqlString(batch)}, ${sqlString(args.note || plan?.name || '')}, ${now}, ${expires ?? 'NULL'});`).join('\n'));
  console.error(`已在${args.remote ? '线上' : '本地'}数据库创建 ${count} 个兑换码：每个 ${credits} credit，批次 ${batch}${expires ? `，${time(expires)} 过期` : '，不过期'}。下面的码只显示这一次，请妥善保存：`);
  for (const code of codes) console.log(code.display);
} else if (command === 'list') {
  const filter = args.batch ? ` WHERE batch = ${sqlString(args.batch)}` : '';
  const list = rows(d1(`SELECT hint, credits, batch, note, created_at, expires_at, redeemed_by, redeemed_at, voided_at FROM redeem_codes${filter} ORDER BY created_at DESC, hint;`, true));
  console.log(['尾号', 'credit', '批次', '备注', '创建', '过期', '状态', '使用账号', '使用时间'].join('\t'));
  for (const row of list) console.log([row.hint, row.credits, row.batch, row.note, time(row.created_at), time(row.expires_at), STATUS[codeStatus(row)], row.redeemed_by || '', time(row.redeemed_at)].join('\t'));
  console.error(`共 ${list.length} 个，已用 ${list.filter(row => row.redeemed_by).length} 个。`);
} else if (command === 'show') {
  const code = args._?.[0] || die('用法：show SF-XXXX-XXXX-XXXX-XXXX');
  const [row] = rows(d1(`SELECT hint, credits, batch, note, created_at, expires_at, redeemed_by, redeemed_at, voided_at FROM redeem_codes WHERE code_hash = ${sqlString(await hashCode(normalizeCode(code)))};`, true));
  if (!row) die('没有这个兑换码。');
  console.log(row.voided_at && !row.redeemed_by ? `已作废：${row.credits} credit（批次 ${row.batch}）` : row.redeemed_by ? `已使用：${row.credits} credit，账号 ${row.redeemed_by}，时间 ${time(row.redeemed_at)}（批次 ${row.batch}）` : `未使用：${row.credits} credit（批次 ${row.batch}${row.expires_at ? `，${time(row.expires_at)} 过期` : ''}）`);
} else die('用法：create | list | show（详见文件开头说明）');
