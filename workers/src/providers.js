// Generation providers. Interface: create({ image }) → { liveId, secret, connId, transport, control },
// hangup({ liveId, connId, secret }), status({ liveId }) → { status, billedSeconds?, creditsCost?, closeReason?, traceId? }.
// The client receives `transport` + `control` and joins whatever real-time channel
// they name, so another provider (e.g. Xmax) only needs a new class here.
import { flag } from './util.js';

// Simulated provider: no network, no cost. State lives in the account object's
// SQLite storage so it survives eviction. Bills whole seconds create → hangup.
export class FakeProvider {
  constructor({ sql, now }) {
    Object.assign(this, { sql, now }); this.name = 'fake';
    sql.exec('CREATE TABLE IF NOT EXISTS fake_lives (live_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER)');
  }
  async create({ image }) {
    if (typeof image !== 'string' || !image.startsWith('data:image/')) throw Object.assign(new Error('这张图片打不开，请换一张 JPG 或 PNG 图片。'), { code: 'BAD_IMAGE' });
    const liveId = 'fake-' + crypto.randomUUID();
    this.sql.exec('INSERT INTO fake_lives (live_id, started_at) VALUES (?, ?)', liveId, this.now());
    return { liveId, secret: null, connId: null, transport: { type: 'fake', room: liveId }, control: { type: 'none' } };
  }
  async hangup({ liveId }) { this.sql.exec('UPDATE fake_lives SET ended_at = ? WHERE live_id = ? AND ended_at IS NULL', this.now(), liveId); }
  async status({ liveId }) {
    const [live] = this.sql.exec('SELECT started_at, ended_at FROM fake_lives WHERE live_id = ?', liveId).toArray();
    if (!live) return { status: 'unknown' };
    if (live.ended_at == null) return { status: 'on_live' };
    return { status: 'ended', billedSeconds: Math.ceil((live.ended_at - live.started_at) / 1000), closeReason: 'user_hangup' };
  }
}

const VIDU = 'https://api.vidu.cn';
// Vidu subject_replacement. PAID: only used with PROVIDER=vidu AND ALLOW_PAID=1 AND a VIDU_API_KEY secret.
export class ViduProvider {
  constructor({ key, resolution }) {
    if (typeof key !== 'string' || !/^vda_[A-Za-z0-9_]{20,200}$/.test(key.trim())) throw new Error('Vidu API Key 未配置或格式无效');
    Object.assign(this, { key: key.trim(), resolution }); this.name = 'vidu';
  }
  async request(route, body) {
    const response = await fetch(VIDU + route, { method: body ? 'POST' : 'GET', headers: { Authorization: this.key, 'Content-Type': 'application/json', 'X-Request-ID': crypto.randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 30000 : 5000) });
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
    const liveId = String(data.live.id), connId = crypto.randomUUID();
    return {
      liveId, secret: data.client_secret, connId,
      transport: { type: 'alirtc', token: data.rtc.token, userId: data.rtc.user_id, renderUid: String(data.render_uid) },
      control: { type: 'vidu-ws', url: 'wss://api.vidu.cn/live/ws/live/connect', liveId, connId, clientSecret: data.client_secret }
    };
  }
  // Server-side hangup: reconnect the control channel with the same conn_id and
  // send the hangup signal. Status polling stays the source of truth.
  // UNVERIFIED on Workers against the real upstream.
  async hangup({ liveId, connId, secret }) {
    if (!secret || !connId) return;
    const url = new URL(VIDU + '/live/ws/live/connect');
    url.search = new URLSearchParams({ live_id: liveId, conn_id: connId, client_secret: secret });
    try {
      const response = await fetch(url, { headers: { Upgrade: 'websocket' }, signal: AbortSignal.timeout(5000) });
      const socket = response.webSocket;
      if (!socket) return;
      socket.accept();
      socket.send(JSON.stringify({ type: 5, live_id: liveId, conn_id: connId, seq_id: 1, payload: { hangup: { hangup_reason: 'user_hangup' } } }));
      await new Promise(resolve => setTimeout(resolve, 300));
      socket.close(1000, 'hangup');
    } catch { /* status polling decides */ }
  }
  async status({ liveId }) {
    const response = await this.request('/live/v1/lives/' + encodeURIComponent(liveId));
    const live = response.live || response;
    if (live.status !== 'ended') return { status: String(live.status || 'unknown') };
    return { status: 'ended', billedSeconds: live.billed_seconds ?? response.billed_seconds ?? null, creditsCost: live.credits_cost ?? response.credits_cost ?? null, closeReason: String(live.close_reason || '').slice(0, 80), traceId: String(live.trace_id || '').slice(0, 80) };
  }
}

export function makeProvider(env, { sql, now }) {
  if (env.PROVIDER === 'vidu') {
    if (!flag(env.ALLOW_PAID)) throw new Error('付费服务商需要 ALLOW_PAID=1');
    return new ViduProvider({ key: env.VIDU_API_KEY, resolution: env.VIDU_RESOLUTION || undefined });
  }
  return new FakeProvider({ sql, now });
}
