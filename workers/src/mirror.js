// DO → D1 summary mirror. The account's Durable Object stays authoritative; it
// appends ops to an outbox in its own storage in the same turn as the balance
// change, then flushes them to D1 in one batch. Every statement is idempotent
// (insert-or-ignore by id, summary guarded by a version), so a flush that is
// retried after a partial failure or a lost response is harmless.
import { beijingDay } from './days.js';

// ops: [{ type: 'ledger' | 'session' | 'audit' | 'summary', row }]
// summary: current totals from the DO (recomputed at flush time), version: last outbox seq.
export function mirrorStatements(db, accountId, ops, summary, version, now) {
  const statements = [];
  for (const { type, row } of ops) {
    if (type === 'ledger') statements.push(db.prepare(
      `INSERT INTO balance_ledger (id, account_id, kind, seconds, code_hash, code_hint, batch, note, reason, actor, created_at, day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
      .bind(row.id, accountId, row.kind, row.seconds, row.code_hash ?? null, row.code_hint ?? null, row.batch ?? null, row.note || '', row.reason || '', row.actor ?? null, row.created_at, beijingDay(row.created_at)));
    else if (type === 'session') statements.push(db.prepare(
      `INSERT INTO session_records (id, account_id, created_at, first_frame_at, ended_at, billed_seconds, had_frame, end_reason, day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET first_frame_at = excluded.first_frame_at, ended_at = excluded.ended_at, billed_seconds = excluded.billed_seconds, had_frame = excluded.had_frame, end_reason = excluded.end_reason`)
      .bind(row.id, accountId, row.created_at, row.first_frame_at ?? null, row.ended_at ?? null, row.billed_seconds, row.first_frame_at ? 1 : 0, row.end_reason || '', beijingDay(row.created_at)));
    else if (type === 'audit') statements.push(db.prepare(
      'INSERT INTO admin_audit (at, actor, action, target, detail, reason, ref) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ref) DO NOTHING')
      .bind(row.at, row.actor, row.action, row.target || '', JSON.stringify(row.detail || {}), row.reason || '', row.ref));
  }
  if (summary) statements.push(db.prepare(
    `INSERT INTO user_summary (account_id, display_id, created_at, balance_seconds, recharged_seconds, used_seconds, last_used_at, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET display_id = excluded.display_id, created_at = excluded.created_at, balance_seconds = excluded.balance_seconds,
       recharged_seconds = excluded.recharged_seconds, used_seconds = excluded.used_seconds, last_used_at = excluded.last_used_at,
       version = excluded.version, updated_at = excluded.updated_at
     WHERE excluded.version >= user_summary.version`)
    .bind(accountId, summary.display_id, summary.created_at, summary.balance_seconds, summary.recharged_seconds, summary.used_seconds, summary.last_used_at ?? null, version, now));
  return statements;
}
