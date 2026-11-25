'use strict';
// Talks to the SoundFace server, which owns provider credentials, accounts and
// quota. The client never holds a provider API key.
class ProxyBackend {
  constructor({ baseUrl = '', fetchImpl = fetch, heartbeatEveryMs = 4000, now = Date.now } = {}) {
    Object.assign(this, { baseUrl: String(baseUrl || '').replace(/\/+$/, ''), fetchImpl, heartbeatEveryMs, now });
    this.token = ''; this.account = null; this.lastHeartbeat = 0;
  }
  get configured() { return Boolean(this.baseUrl && this.token); }
  async request(method, route, body, timeoutMs = 15000) {
    if (!this.baseUrl) throw new Error('服务暂时用不了，请更新到最新版，或联系客服。');
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + route, { method, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new Error('连不上服务器，请检查网络。'); }
    let data = {}; try { data = await response.json(); } catch { /* non-JSON error page */ }
    if (!response.ok) {
      const code = String(data.code || 'REQUEST_FAILED').replace(/[^A-Z_]/g, '').slice(0, 60);
      const messages = { UNAUTHENTICATED: '登录过期了，请重新登录。', QUOTA_EXHAUSTED: '剩余时长不到 1 分钟，请先充值。', SESSION_ACTIVE: '上一次的数字人还没完全停止，请先点“停止数字人”。', UPSTREAM_CREATE_FAILED: '数字人服务暂时用不了，请过一会儿再试。' };
      // Validation and login messages are authored by our own server; show them as-is.
      const own = [400, 402, 429].includes(response.status) && typeof data.message === 'string' && data.message.length <= 60 ? data.message : '';
      throw Object.assign(new Error(messages[code] || own || `出了点问题，请再试一次。（错误代码：${response.status} · ${code}）`), { code, status: response.status });
    }
    return data;
  }
  async login(method, body) {
    const result = await this.request('POST', `/v1/auth/${encodeURIComponent(method)}/login`, body);
    this.token = result.token; this.account = result.account; return this.account;
  }
  requestCode(method, body) { return this.request('POST', `/v1/auth/${encodeURIComponent(method)}/code`, body); }
  restore(token) { this.token = typeof token === 'string' ? token : ''; this.account = null; }
  logout() { this.token = ''; this.account = null; }
  async refreshAccount() { this.account = await this.request('GET', '/v1/me'); return this.account; }
  create(image) { return this.request('POST', '/v1/sessions', { image }, 45000); }
  hangup(sessionId) { return this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/hangup`, {}, 30000); }
  status(sessionId) { return this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}`); }
  // Throttled; resolves to the server's session view, or null when skipped/failed.
  // `frames` = generated frames shown so far; the server bills from the first one.
  heartbeat(sessionId, frames = 0) {
    if (this.now() - this.lastHeartbeat < this.heartbeatEveryMs) return Promise.resolve(null);
    this.lastHeartbeat = this.now();
    return this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`, { frames: Number(frames) || 0 }, 5000).then(view => {
      if (this.account && Number.isFinite(view?.remainingSeconds)) this.account = { ...this.account, remainingSeconds: view.remainingSeconds, remainingMinutes: Math.floor(view.remainingSeconds / 60) };
      return view;
    }).catch(() => null);
  }
  // Credits: redeem codes, purchase and usage history, packages for display.
  async redeem(code) { const result = await this.request('POST', '/v1/redeem', { code }); this.account = result.account; return result; }
  history() { return this.request('GET', '/v1/history'); }
  plans() { return this.request('GET', '/v1/plans'); }
}

module.exports = { ProxyBackend };
