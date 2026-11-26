// Login methods. Each verifies its own request body and returns { accountId, name }.
// One-time codes live in D1 (single writer, so the attempt counter is exact).
// Development senders send nothing and use the fixed code 000000; they exist
// only when DEV_LOGIN=1, which production must never set.
import { fail, sha256, randomDigits, maskPhone, maskEmail, flag } from './util.js';

const CODE_TTL_MS = 5 * 60 * 1000, RESEND_MS = 60 * 1000, MAX_ATTEMPTS = 5;
const EMAIL = /^[^\s@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

class CodeAuthenticator {
  constructor({ db, sender, now }) { Object.assign(this, { db, sender, now }); }
  async requestCode(body) {
    const id = this.identifier(body);
    const existing = await this.db.prepare('SELECT sent_at FROM login_codes WHERE method = ? AND identifier = ?').bind(this.method, id).first();
    if (existing && this.now() - existing.sent_at < RESEND_MS) fail(429, 'CODE_TOO_FREQUENT', '验证码发送太频繁，请稍后再试');
    const code = this.sender.fixedCode || randomDigits(6);
    await this.sender.send(id, code);
    await this.db.prepare('INSERT INTO login_codes (method, identifier, code_hash, sent_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT (method, identifier) DO UPDATE SET code_hash = excluded.code_hash, sent_at = excluded.sent_at, attempts = 0')
      .bind(this.method, id, await sha256(`${this.method}:${id}:${code}`), this.now()).run();
    return { resendAfterSeconds: RESEND_MS / 1000, ...(this.sender.devHint ? { devHint: this.sender.devHint } : {}) };
  }
  async verify(body) {
    const id = this.identifier(body), code = String(body?.code ?? '');
    const entry = await this.db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE method = ? AND identifier = ? RETURNING code_hash, sent_at, attempts').bind(this.method, id).first();
    if (!entry || this.now() - entry.sent_at > CODE_TTL_MS) fail(400, 'CODE_EXPIRED', '验证码已过期，请重新获取');
    if (entry.attempts > MAX_ATTEMPTS) { await this.forget(id); fail(429, 'CODE_LOCKED', '尝试次数过多，请重新获取验证码'); }
    if (await sha256(`${this.method}:${id}:${code}`) !== entry.code_hash) fail(400, 'CODE_WRONG', '验证码不正确');
    await this.forget(id);
    return this.account(id);
  }
  forget(id) { return this.db.prepare('DELETE FROM login_codes WHERE method = ? AND identifier = ?').bind(this.method, id).run(); }
}

export class SmsAuthenticator extends CodeAuthenticator {
  get method() { return 'sms'; }
  identifier(body) {
    const phone = typeof body?.phone === 'string' ? body.phone.replace(/\s+/g, '') : '';
    if (!/^1[3-9]\d{9}$/.test(phone)) fail(400, 'BAD_PHONE', '请输入 11 位手机号');
    return phone;
  }
  account(phone) { return { accountId: 'phone:' + phone, name: maskPhone(phone) }; }
}

// Email and phone accounts are separate; linking is not supported yet.
export class EmailAuthenticator extends CodeAuthenticator {
  get method() { return 'email'; }
  identifier(body) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL.test(email)) fail(400, 'BAD_EMAIL', '请输入正确的邮箱地址');
    return email;
  }
  account(email) { return { accountId: 'email:' + email, name: maskEmail(email) }; }
}

export class DevAuthenticator {
  get method() { return 'dev'; }
  async verify(body) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(name)) fail(400, 'BAD_NAME', '开发登录需要 2–32 位字母、数字、下划线或短横线');
    return { accountId: 'dev:' + name, name };
  }
}

class DevSender {
  constructor(kind) { this.kind = kind; this.fixedCode = '000000'; this.devHint = `开发服务端：验证码固定为 000000，不会真实发送${kind === 'email' ? '邮件' : '短信'}`; }
  async send(id) { console.log(`[dev-${this.kind}] ${this.kind === 'email' ? maskEmail(id) : maskPhone(id)} 验证码 000000（开发模式，未真实发送）`); }
}

// Cloudflare Email Service (Workers `send_email` binding). Needs an onboarded
// sending domain and the Workers Paid plan to reach arbitrary recipients.
export class CloudflareEmailSender {
  constructor({ binding, from }) { Object.assign(this, { binding, from }); }
  async send(email, code) {
    try {
      await this.binding.send({
        to: email, from: { email: this.from, name: 'SoundFace' }, subject: `SoundFace 登录验证码：${code}`,
        text: `你的 SoundFace 登录验证码是 ${code}，5 分钟内有效。\n如果不是你本人操作，请忽略这封邮件。`,
        html: `<p>你的 SoundFace 登录验证码是</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>5 分钟内有效。如果不是你本人操作，请忽略这封邮件。</p>`
      });
    } catch (error) {
      console.error('[email]', error?.code || '', error?.message || error);
      fail(502, 'EMAIL_SEND_FAILED', '验证码邮件发送失败，请稍后再试');
    }
  }
}

export function loginMethods(env, now) {
  const db = env.DB, methods = new Map();
  const add = item => methods.set(item.method, item);
  if (flag(env.DEV_LOGIN)) {
    add(new DevAuthenticator());
    add(new SmsAuthenticator({ db, now, sender: new DevSender('sms') }));
    add(new EmailAuthenticator({ db, now, sender: new DevSender('email') }));
  } else if (env.EMAIL && env.MAIL_FROM) {
    add(new EmailAuthenticator({ db, now, sender: new CloudflareEmailSender({ binding: env.EMAIL, from: env.MAIL_FROM }) }));
  }
  // Production SMS: provider not chosen yet, so there is no production SMS login.
  return methods;
}

// Bearer token → account id (401 when missing or unknown). Shared by the app API and the admin API.
export async function authenticate(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const row = token ? await env.DB.prepare('SELECT user_id FROM tokens WHERE token_hash = ?').bind(await sha256(token)).first() : null;
  if (!row) fail(401, 'UNAUTHENTICATED', '请先登录');
  return row.user_id;
}

// Admin = logged in (401 otherwise) with an EMAIL account listed in ADMIN_EMAILS
// (comma-separated secret; 403 otherwise). An empty or missing list admits nobody.
export const adminEmails = env => String(env.ADMIN_EMAILS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
export async function authenticateAdmin(request, env) {
  const userId = await authenticate(request, env);
  const email = userId.startsWith('email:') ? userId.slice(6) : null;
  if (!email || !adminEmails(env).includes(email)) fail(403, 'NOT_ADMIN', '这个账号没有管理后台的权限');
  return email;
}
