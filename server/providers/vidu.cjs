'use strict';
// Vidu subject_replacement provider. PAID: only constructed when the server is
// started with SOUNDFACE_PROVIDER=vidu AND SOUNDFACE_ALLOW_PAID=1. The API key
// stays on the server; clients receive only per-session RTC credentials and
// the per-session control secret.
const { randomUUID } = require('node:crypto');
const API = 'https://api.vidu.cn';

class ViduProvider {
  constructor({ key, fetchImpl = fetch, Socket = globalThis.WebSocket, resolution } = {}) {
    if (typeof key !== 'string' || !/^vda_[A-Za-z0-9_]{20,200}$/.test(key.trim())) throw new Error('Vidu API Key 未配置或格式无效');
    Object.assign(this, { key: key.trim(), fetchImpl, Socket, resolution });
    this.name = 'vidu';
  }
  async request(route, body) {
    const response = await this.fetchImpl(API + route, { method: body ? 'POST' : 'GET', headers: { Authorization: this.key, 'Content-Type': 'application/json', 'X-Request-ID': randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 30000 : 5000) });
    const data = await response.json();
    if (!response.ok) {
      const reason = String(data.reason || data.code || 'REQUEST_FAILED').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100);
      throw Object.assign(new Error(`上游 HTTP ${response.status} · ${reason}`), { code: reason });
    }
    return data;
  }
  async create({ image }) {
    const data = await this.request('/live/s_editing/realtime', { image_url: image, editing_type: 'subject_replacement', ...(this.resolution ? { resolution: this.resolution } : {}) });
    if (!data.live?.id || !data.rtc?.token || !data.render_uid || !data.client_secret) throw Object.assign(new Error('上游响应缺少会话或连接凭证'), { code: 'BAD_UPSTREAM_RESPONSE', liveId: data.live?.id ? String(data.live.id) : null });
    const liveId = String(data.live.id), connId = randomUUID();
    return {
      liveId, secret: data.client_secret, connId,
      transport: { type: 'alirtc', token: data.rtc.token, userId: data.rtc.user_id, renderUid: String(data.render_uid) },
      control: { type: 'vidu-ws', url: API.replace('https:', 'wss:') + '/live/ws/live/connect', liveId, connId, clientSecret: data.client_secret }
    };
  }
  // Server-side hangup: reconnect the control channel with the same conn_id
  // and send the hangup signal. Status polling remains the source of truth.
  hangup({ liveId, connId, secret }) {
    if (!secret || !connId || !this.Socket) return Promise.resolve();
    return new Promise(resolve => {
      const url = new URL('/live/ws/live/connect', API.replace('https:', 'wss:'));
      url.search = new URLSearchParams({ live_id: liveId, conn_id: connId, client_secret: secret });
      let socket; const done = () => { clearTimeout(timer); try { socket?.close(); } catch { /* closed */ } resolve(); };
      const timer = setTimeout(done, 5000);
      try { socket = new this.Socket(url.href); } catch { done(); return; }
      socket.addEventListener('open', () => { socket.send(JSON.stringify({ type: 5, live_id: liveId, conn_id: connId, seq_id: 1, payload: { hangup: { hangup_reason: 'user_hangup' } } })); setTimeout(done, 300); });
      socket.addEventListener('error', done);
    });
  }
  async status({ liveId }) {
    const response = await this.request('/live/v1/lives/' + encodeURIComponent(liveId));
    const live = response.live || response;
    if (live.status !== 'ended') return { status: String(live.status || 'unknown') };
    return { status: 'ended', billedSeconds: live.billed_seconds ?? response.billed_seconds ?? null, creditsCost: live.credits_cost ?? response.credits_cost ?? null, closeReason: String(live.close_reason || '').slice(0, 80), traceId: String(live.trace_id || '').slice(0, 80) };
  }
}

module.exports = { ViduProvider };
