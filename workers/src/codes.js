// Redeem codes: one generator shared by the admin console (Worker) and the
// `npm run codes` CLI (Node), so there is only one kind of code. WebCrypto only,
// which both runtimes provide. The database stores SHA-256(normalised body) and
// the last 4 characters; the plaintext is shown once at creation.
import { sha256 } from './util.js';

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const FIRST = ALPHABET.replace('S', '');                     // never 'S', so "SF" stays unambiguous without the prefix

export const normalizeCode = code => String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^SF/, '');
export const hashCode = body => sha256(body);
export const codeHint = body => body.slice(-4);

// Uniform integer in [0, n) without modulo bias.
function randomBelow(n) {
  const limit = 256 - (256 % n);
  for (;;) { const [value] = crypto.getRandomValues(new Uint8Array(1)); if (value < limit) return value % n; }
}

// 16 random characters = 80 bits, displayed as SF-XXXX-XXXX-XXXX-XXXX.
export function newCode() {
  let body = FIRST[randomBelow(FIRST.length)];
  for (let i = 1; i < 16; i++) body += ALPHABET[randomBelow(ALPHABET.length)];
  return { body, display: 'SF-' + body.match(/.{4}/g).join('-') };
}

export const newBatchId = now => 'b' + new Date(now).toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 7);

// Generates `count` codes and returns { batch, codes: [{ body, display, hash, hint }] }.
export async function generateCodes(count, now = Date.now()) {
  const codes = [];
  for (let i = 0; i < count; i++) { const code = newCode(); codes.push({ ...code, hash: await hashCode(code.body), hint: codeHint(code.body) }); }
  return { batch: newBatchId(now), codes };
}

// Status shown in the admin console. A redeemed code stays "已兑换" even if it
// would have expired later; voiding only ever applies to unused codes.
export function codeStatus(row, now = Date.now()) {
  if (row.redeemed_by) return 'redeemed';
  if (row.voided_at) return 'voided';
  if (row.expires_at && row.expires_at <= now) return 'expired';
  return 'unused';
}
