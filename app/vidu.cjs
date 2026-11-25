const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const API = 'https://api.vidu.cn';

// The permanent API key never crosses IPC. Only short-lived RTC credentials do.
class ViduSession extends EventEmitter {
  constructor({ key = '', image, characterExists = id => id === 'qinghe', fetchImpl = fetch, Socket = WebSocket, pollDelay = 700 } = {}) {
    super(); Object.assign(this, { key, image, characterExists, fetchImpl, Socket, pollDelay });
    this.state = { phase: 'idle', billing: 'none', frames: 0, error: '' };
    this.generation = 0; this.live = null; this.socket = null; this.starting = null; this.stopping = null;
  }
  snapshot() { return { ...this.state, configured: Boolean(this.key) }; }
  publish(values) { Object.assign(this.state, values); this.emit('state', this.snapshot()); return this.snapshot(); }
  configure(key) {
    if (this.starting || this.live) throw new Error('请先结束云端会话');
    if (typeof key !== 'string' || !/^vda_[A-Za-z0-9_]{20,200}$/.test(key.trim())) throw new Error('Vidu API Key 格式无效');
    this.key = key.trim(); return this.publish({ error: '' });
  }
  async request(route, body) {
    const response = await this.fetchImpl(API + route, { method: body ? 'POST' : 'GET', headers: { Authorization: this.key, 'Content-Type': 'application/json', 'X-Request-ID': randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 30000 : 5000) });
    const data = await response.json();
    if (!response.ok) {
      const reason = String(data.reason || data.code || 'REQUEST_FAILED').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100);
      const explanations = { CreditInsufficient: '账户积分不足', UNAUTHORIZED: '服务连接异常，请联系支持', FORBIDDEN: '账户尚无该服务权限' };
      throw new Error(`Vidu HTTP ${response.status} · ${reason}${explanations[reason] ? ' · ' + explanations[reason] : ''}`);
    }
    return data;
  }
  start(characterId) {
    if (!this.characterExists(characterId)) return Promise.reject(new Error('该角色不可用，请重新选择。'));
    if (!this.key) return Promise.reject(new Error('云端服务暂不可用，请更新应用或联系支持。'));
    if (this.starting || this.stopping || this.live || this.state.billing === 'unknown') return Promise.reject(new Error('请先结束并确认上一场会话'));
    let reference;
    try { reference = this.image(characterId); } catch (error) { return Promise.reject(error); }
    const generation = ++this.generation;
    this.publish({ phase: 'creating', characterId, billing: 'none', error: '', frames: 0, width: 0, height: 0, startedAt: null, firstFrameMs: null, billedSeconds: null, creditsCost: null, liveId: null, closeReason: '', traceId: '' });
    const work = async () => {
      try {
        const data = await this.request('/live/s_editing/realtime', { image_url: reference, editing_type: 'subject_replacement' });
        if (!data.live?.id) throw new Error('Vidu 创建响应缺少会话 ID');
        this.live = { id: String(data.live.id), connId: randomUUID(), secret: data.client_secret, seq: 1 };
        this.publish({ liveId: this.live.id, phase: 'connecting', billing: 'waiting' });
        if (generation !== this.generation) throw new Error('云端启动已取消');
        if (!data.rtc?.token || !data.render_uid || !data.client_secret) throw new Error('Vidu 响应缺少连接凭证');
        await this.connect(true);
        if (generation !== this.generation) throw new Error('云端启动已取消');
        this.heartbeatAt = Date.now();
        this.watchdog = setInterval(() => { if (Date.now() - this.heartbeatAt > 10000) void this.stop('界面失去响应，已停止云端会话'); }, 2000);
        this.publish({ phase: 'waiting_frames', billing: 'active', startedAt: Date.now() });
        return { rtc: data.rtc, renderUid: String(data.render_uid) };
      } catch (error) {
        // Keep the live ID after cancellation so the server session can still be ended.
        await this.endRemote(); this.publish({ phase: 'error', error: error.message }); throw error;
      }
    };
    this.starting = work().finally(() => { this.starting = null; });
    return this.starting;
  }
  signal(type, payload) {
    if (!this.live || this.socket?.readyState !== 1) throw new Error('云端控制连接未就绪');
    this.socket.send(JSON.stringify({ type, live_id: this.live.id, conn_id: this.live.connId, seq_id: this.live.seq++, payload }));
  }
  connect(initialize) {
    const live = this.live;
    return new Promise((resolve, reject) => {
      const url = new URL('/live/ws/live/connect', API.replace('https:', 'wss:'));
      url.search = new URLSearchParams({ live_id: live.id, conn_id: live.connId, client_secret: live.secret });
      this.socket?.close();
      const socket = this.socket = new this.Socket(url.href);
      let settled = false, retry;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(retry); if (initialize) this.cancelConnect = null; error ? reject(error) : resolve(); };
      const timeout = setTimeout(() => finish(new Error('Vidu 连接初始化超时')), initialize ? 60000 : 5000);
      if (initialize) this.cancelConnect = () => finish(new Error('云端启动已取消'));
      socket.addEventListener('open', () => {
        if (settled || this.socket !== socket) return;
        if (initialize) this.signal(1, { conn_init: { version: 1 } }); else finish();
      });
      socket.addEventListener('message', event => {
        if (this.socket !== socket) return;
        let data; try { data = JSON.parse(event.data); } catch { return; }
        const ack = data.payload?.conn_init_ack;
        if (data.type === 2 && ack && !settled) {
          if (ack.success) finish();
          else if (ack.error_code === 'NOT_READY') retry = setTimeout(() => { if (socket.readyState === 1) this.signal(1, { conn_init: { version: 1 } }); }, 2000);
          else finish(new Error(`Vidu 初始化失败 · ${String(ack.error_code).replace(/[^A-Z_]/g, '').slice(0, 80)}`));
        }
        if (data.type === 6 && settled && !this.stopping) void this.stop('服务端已结束会话');
      });
      socket.addEventListener('error', () => finish(new Error('Vidu 控制连接失败')));
      socket.addEventListener('close', () => {
        if (!settled) finish(new Error('Vidu 控制连接提前关闭'));
        else if (!this.stopping && this.state.billing === 'active') void this.stop('云端连接断开');
      });
    });
  }
  heartbeat(metrics = {}) {
    this.heartbeatAt = Date.now();
    if (!['waiting_frames', 'live'].includes(this.state.phase)) return this.snapshot();
    const frames = Number(metrics.frames);
    if (Number.isSafeInteger(frames) && frames > this.state.frames) {
      const firstFrameMs = this.state.firstFrameMs ?? Date.now() - this.state.startedAt;
      this.publish({ phase: 'live', frames, width: Math.min(8192, Number(metrics.width) || 0), height: Math.min(8192, Number(metrics.height) || 0), firstFrameMs });
    }
    return this.snapshot();
  }
  async endRemote() {
    clearInterval(this.watchdog);
    if (!this.live) return;
    this.publish({ billing: 'ending' });
    try {
      if (this.socket?.readyState !== 1 && this.live.secret) await this.connect(false);
      this.signal(5, { hangup: { hangup_reason: 'user_hangup' } });
    } catch { /* The status query below is authoritative, not a sent packet. */ }
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const response = await this.request('/live/v1/lives/' + encodeURIComponent(this.live.id));
        const live = response.live || response;
        if (live.status === 'ended') {
          this.socket?.close(); this.socket = null; this.live = null;
          this.publish({ billing: 'ended', billedSeconds: live.billed_seconds ?? response.billed_seconds ?? null, creditsCost: live.credits_cost ?? response.credits_cost ?? null, closeReason: live.close_reason || '', traceId: live.trace_id || '' }); return;
        }
      } catch { break; }
      await delay(this.pollDelay);
    }
    this.socket?.close(); this.socket = null;
    this.publish({ billing: 'unknown', error: '本地已停止，但云端结束未确认，请重试结束或到 Vidu 控制台查看。' });
  }
  stop(reason = '') {
    if (this.stopping) return this.stopping;
    ++this.generation;
    this.cancelConnect?.();
    if (!this.starting && !this.live) return Promise.resolve(this.snapshot());
    this.publish({ phase: 'stopping', error: reason });
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      await this.endRemote();
      return this.publish({ phase: this.state.billing === 'unknown' ? 'error' : 'ended' });
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
module.exports = { ViduSession };
