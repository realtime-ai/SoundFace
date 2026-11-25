// Shared helpers. Error messages are user-facing Chinese text shown as-is by the client.
export class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Uniform 6-digit code without modulo bias.
export function randomDigits(length = 6) {
  let out = '';
  while (out.length < length) {
    const [value] = crypto.getRandomValues(new Uint8Array(1));
    if (value < 250) out += String(value % 10);
  }
  return out;
}

export const maskPhone = phone => phone.slice(0, 3) + '****' + phone.slice(7);
export const maskEmail = email => { const [local, domain] = email.split('@'); return (local.length <= 2 ? local[0] : local.slice(0, 2)) + '***@' + domain; };
export const flag = value => value === '1' || value === 'true';
export const intVar = (value, fallback) => { const number = Number.parseInt(value, 10); return Number.isSafeInteger(number) ? number : fallback; };
