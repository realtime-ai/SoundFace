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
    if (!this.baseUrl) throw new Error('云端服务未配置，请更新应用或联系支持。');
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + route, { method, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new Error('无法连接 SoundFace 服务，请检查网络。'); }
    let data = {}; try { data = await response.json(); } catch { /* non-JSON error page */ }
    if (!response.ok) {
      const code = String(data.code || 'REQUEST_FAILED').replace(/[^A-Z_]/g, '').slice(0, 60);
      const messages = { UNAUTHENTICATED: '登录已失效，请重新登录。', QUOTA_EXHAUSTED: '剩余时长不足，无法开始新会话。', SESSION_ACTIVE: '上一场会话尚未结束确认，请先结束。', UPSTREAM_CREATE_FAILED: '生成服务暂时不可用，请稍后重试。' };
      // Validation and login messages are authored by our own server; show them as-is.
      const own = [400, 429].includes(response.status) && typeof data.message === 'string' && data.message.length <= 60 ? data.message : '';
      throw Object.assign(new Error(messages[code] || own || `服务请求失败（${response.status} · ${code}）`), { code, status: response.status });
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
  heartbeat(sessionId) {
    if (this.now() - this.lastHeartbeat < this.heartbeatEveryMs) return Promise.resolve(null);
    this.lastHeartbeat = this.now();
    return this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {}, 5000).catch(() => null);
  }
}

module.exports = { ProxyBackend };
