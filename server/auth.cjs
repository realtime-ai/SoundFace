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

// Phone + SMS code login, with a pluggable sender. The production SMS
// provider is not chosen yet; DevSmsSender sends nothing and accepts the fixed
// code 000000, and is only registered with SOUNDFACE_DEV_LOGIN=1.
class SmsAuthenticator {
  constructor({ sender, now = Date.now, codeTtlMs = 5 * 60 * 1000, resendMs = 60 * 1000, maxAttempts = 5 }) {
    Object.assign(this, { sender, now, codeTtlMs, resendMs, maxAttempts });
    this.method = 'sms'; this.codes = new Map();
  }
  phone(body) {
    const phone = typeof body?.phone === 'string' ? body.phone.replace(/\s+/g, '') : '';
    if (!/^1[3-9]\d{9}$/.test(phone)) throw Object.assign(new Error('请输入 11 位手机号'), { status: 400, code: 'BAD_PHONE' });
    return phone;
  }
  async requestCode(body) {
    const phone = this.phone(body), existing = this.codes.get(phone);
    if (existing && this.now() - existing.sentAt < this.resendMs) throw Object.assign(new Error('验证码发送太频繁，请稍后再试'), { status: 429, code: 'CODE_TOO_FREQUENT' });
    const code = await this.sender.send(phone);
    this.codes.set(phone, { code, sentAt: this.now(), attempts: 0 });
    return { resendAfterSeconds: Math.round(this.resendMs / 1000), ...(this.sender.devHint ? { devHint: this.sender.devHint } : {}) };
  }
  async verify(body) {
    const phone = this.phone(body), entry = this.codes.get(phone), code = String(body?.code || '');
    if (!entry || this.now() - entry.sentAt > this.codeTtlMs) throw Object.assign(new Error('验证码已过期，请重新获取'), { status: 400, code: 'CODE_EXPIRED' });
    if (++entry.attempts > this.maxAttempts) { this.codes.delete(phone); throw Object.assign(new Error('尝试次数过多，请重新获取验证码'), { status: 429, code: 'CODE_LOCKED' }); }
    if (code !== entry.code) throw Object.assign(new Error('验证码不正确'), { status: 400, code: 'CODE_WRONG' });
    this.codes.delete(phone);
    return { accountId: 'phone:' + phone, name: phone.slice(0, 3) + '****' + phone.slice(7) };
  }
}
class DevSmsSender { constructor() { this.devHint = '开发服务端：验证码固定为 000000，不会真实发送短信'; } async send(phone) { console.log(`[dev-sms] ${phone.slice(0, 3)}****${phone.slice(7)} 验证码 000000（开发模式，未真实发送）`); return '000000'; } }

module.exports = { DevAuthenticator, SmsAuthenticator, DevSmsSender };
