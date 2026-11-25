'use strict';
// Login is pluggable: each authenticator verifies its own request body and
// returns a stable account id + display name. The production method (likely
// SMS) is not chosen yet; only the development login exists, and it is
// registered only when the server is started with SOUNDFACE_DEV_LOGIN=1.
class DevAuthenticator {
  constructor() { this.method = 'dev'; }
  async verify(body) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(name)) throw Object.assign(new Error('开发登录需要 2–32 位字母、数字、下划线或短横线'), { status: 400 });
    return { accountId: 'dev:' + name, name };
  }
}

// One-time-code login (phone + SMS, email + mail) with a pluggable sender.
// Production senders are not chosen yet; the Dev* senders send nothing and
// accept the fixed code 000000, and are only registered with SOUNDFACE_DEV_LOGIN=1.
class CodeAuthenticator {
  constructor({ sender, now = Date.now, codeTtlMs = 5 * 60 * 1000, resendMs = 60 * 1000, maxAttempts = 5 }) {
    Object.assign(this, { sender, now, codeTtlMs, resendMs, maxAttempts });
    this.codes = new Map();
  }
  async requestCode(body) {
    const id = this.identifier(body), existing = this.codes.get(id);
    if (existing && this.now() - existing.sentAt < this.resendMs) throw Object.assign(new Error('验证码发送太频繁，请稍后再试'), { status: 429, code: 'CODE_TOO_FREQUENT' });
    const code = await this.sender.send(id);
    this.codes.set(id, { code, sentAt: this.now(), attempts: 0 });
    return { resendAfterSeconds: Math.round(this.resendMs / 1000), ...(this.sender.devHint ? { devHint: this.sender.devHint } : {}) };
  }
  async verify(body) {
    const id = this.identifier(body), entry = this.codes.get(id), code = String(body?.code || '');
    if (!entry || this.now() - entry.sentAt > this.codeTtlMs) throw Object.assign(new Error('验证码已过期，请重新获取'), { status: 400, code: 'CODE_EXPIRED' });
    if (++entry.attempts > this.maxAttempts) { this.codes.delete(id); throw Object.assign(new Error('尝试次数过多，请重新获取验证码'), { status: 429, code: 'CODE_LOCKED' }); }
    if (code !== entry.code) throw Object.assign(new Error('验证码不正确'), { status: 400, code: 'CODE_WRONG' });
    this.codes.delete(id);
    return this.account(id);
  }
}
class SmsAuthenticator extends CodeAuthenticator {
  constructor(options) { super(options); this.method = 'sms'; }
  identifier(body) {
    const phone = typeof body?.phone === 'string' ? body.phone.replace(/\s+/g, '') : '';
    if (!/^1[3-9]\d{9}$/.test(phone)) throw Object.assign(new Error('请输入 11 位手机号'), { status: 400, code: 'BAD_PHONE' });
    return phone;
  }
  account(phone) { return { accountId: 'phone:' + phone, name: maskPhone(phone) }; }
}
// Email accounts are separate from phone accounts; linking is not supported yet.
const EMAIL = /^[^\s@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;
class EmailAuthenticator extends CodeAuthenticator {
  constructor(options) { super(options); this.method = 'email'; }
  identifier(body) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL.test(email)) throw Object.assign(new Error('请输入正确的邮箱地址'), { status: 400, code: 'BAD_EMAIL' });
    return email;
  }
  account(email) { return { accountId: 'email:' + email, name: maskEmail(email) }; }
}
const maskPhone = phone => phone.slice(0, 3) + '****' + phone.slice(7);
const maskEmail = email => { const [local, domain] = email.split('@'); return (local.length <= 2 ? local[0] : local.slice(0, 2)) + '***@' + domain; };
class DevSmsSender { constructor() { this.devHint = '开发服务端：验证码固定为 000000，不会真实发送短信'; } async send(phone) { console.log(`[dev-sms] ${maskPhone(phone)} 验证码 000000（开发模式，未真实发送）`); return '000000'; } }
class DevEmailSender { constructor() { this.devHint = '开发服务端：验证码固定为 000000，不会真实发送邮件'; } async send(email) { console.log(`[dev-email] ${maskEmail(email)} 验证码 000000（开发模式，未真实发送）`); return '000000'; } }

module.exports = { DevAuthenticator, SmsAuthenticator, EmailAuthenticator, DevSmsSender, DevEmailSender, maskEmail };
