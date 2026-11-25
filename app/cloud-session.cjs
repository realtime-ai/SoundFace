'use strict';
// Client-side lifecycle of one generation session. Credentials, accounts and
// settlement live on the SoundFace server (see app/cloud-backend.cjs). The
// server answers with a provider-neutral { transport, control }:
//   transport.type — which real-time channel the renderer joins ('alirtc' today)
//   control.type   — 'vidu-ws' (provider control socket) or 'none'
const { EventEmitter } = require('node:events');

class CloudSession extends EventEmitter {
  constructor({ backend, image, characterExists = id => id === 'qinghe', Socket = globalThis.WebSocket } = {}) {
    super(); Object.assign(this, { backend, image, characterExists, Socket });
    this.state = { phase: 'idle', billing: 'none', frames: 0, error: '' };
    this.generation = 0; this.live = null; this.socket = null; this.starting = null; this.stopping = null;
  }
  snapshot() {
    const account = this.backend.account;
    return { ...this.state, configured: this.backend.configured, account: account ? { name: account.name, remainingSeconds: account.remainingSeconds } : null };
  }
  publish(values) { Object.assign(this.state, values); this.emit('state', this.snapshot()); return this.snapshot(); }
  start(characterId) {
    if (!this.characterExists(characterId)) return Promise.reject(new Error('该角色不可用，请重新选择。'));
    if (!this.backend.configured) return Promise.reject(new Error('请先登录 SoundFace 账号。'));
    if (this.starting || this.stopping || this.live || this.state.billing === 'unknown') return Promise.reject(new Error('请先结束并确认上一场会话'));
    let reference;
    try { reference = this.image(characterId); } catch (error) { return Promise.reject(error); }
    const generation = ++this.generation;
    this.publish({ phase: 'creating', characterId, billing: 'none', error: '', frames: 0, width: 0, height: 0, startedAt: null, firstFrameMs: null, billedSeconds: null, creditsCost: null, liveId: null, closeReason: '', traceId: '' });
    const work = async () => {
      try {
        const created = await this.backend.create(reference);
        if (!created?.sessionId || !created.transport?.type) throw new Error('服务响应缺少会话信息');
        this.live = { id: String(created.sessionId), control: created.control || { type: 'none' }, seq: 1 };
        this.publish({ liveId: this.live.id, phase: 'connecting', billing: 'waiting' });
        // Keep the server session alive from creation on, including a slow
        // provider initialization, so the server reaper does not end it.
        this.keepalive = setInterval(() => this.keepServerAlive(), 5000); this.keepServerAlive();
        if (generation !== this.generation) throw new Error('云端启动已取消');
        if (this.live.control.type === 'vidu-ws') await this.connect(true);
        if (generation !== this.generation) throw new Error('云端启动已取消');
        this.heartbeatAt = Date.now();
        this.watchdog = setInterval(() => { if (Date.now() - this.heartbeatAt > 10000) void this.stop('界面失去响应，已停止云端会话'); }, 2000);
        this.publish({ phase: 'waiting_frames', billing: 'active', startedAt: Date.now() });
        return { transport: created.transport };
      } catch (error) {
        // Keep the session ID after cancellation so the server session can still be ended.
        await this.endRemote(); this.publish({ phase: 'error', error: error.message }); throw error;
      }
    };
    this.starting = work().finally(() => { this.starting = null; });
    return this.starting;
  }
  signal(type, payload) {
    const control = this.live?.control;
    if (!control || control.type !== 'vidu-ws' || this.socket?.readyState !== 1) throw new Error('云端控制连接未就绪');
    this.socket.send(JSON.stringify({ type, live_id: control.liveId, conn_id: control.connId, seq_id: this.live.seq++, payload }));
  }
  connect(initialize) {
    const control = this.live.control;
    return new Promise((resolve, reject) => {
      const url = new URL(control.url);
      if (url.protocol !== 'wss:') { reject(new Error('云端控制地址无效')); return; }
      url.search = new URLSearchParams({ live_id: control.liveId, conn_id: control.connId, client_secret: control.clientSecret });
      this.socket?.close();
      const socket = this.socket = new this.Socket(url.href);
      let settled = false, retry;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(retry); if (initialize) this.cancelConnect = null; error ? reject(error) : resolve(); };
      const timeout = setTimeout(() => finish(new Error('云端连接初始化超时')), initialize ? 60000 : 5000);
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
          else finish(new Error(`云端初始化失败 · ${String(ack.error_code).replace(/[^A-Z_]/g, '').slice(0, 80)}`));
        }
        if (data.type === 6 && settled && !this.stopping) void this.stop('服务端已结束会话');
      });
      socket.addEventListener('error', () => finish(new Error('云端控制连接失败')));
      socket.addEventListener('close', () => {
        if (!settled) finish(new Error('云端控制连接提前关闭'));
        else if (!this.stopping && this.state.billing === 'active') void this.stop('云端连接断开');
      });
    });
  }
  keepServerAlive() {
    const id = this.live?.id; if (!id) return;
    Promise.resolve(this.backend.heartbeat(id, this.state.frames || 0)).then(view => {
      if (!view || view.state === 'active' || this.live?.id !== id || this.stopping) return;
      const reasons = { quota_reached: '时长已用完，会话已结束。', client_lost: '与 SoundFace 服务的连接中断，会话已结束。' };
      void this.stop(reasons[view.endReason] || '服务端已结束会话。');
    }).catch(() => {});
  }
  heartbeat(metrics = {}) {
    this.heartbeatAt = Date.now();
    const frames = Number(metrics.frames);
    if (['waiting_frames', 'live'].includes(this.state.phase) && Number.isSafeInteger(frames) && frames > this.state.frames) {
      const firstFrameMs = this.state.firstFrameMs ?? Date.now() - this.state.startedAt;
      this.publish({ phase: 'live', frames, width: Math.min(8192, Number(metrics.width) || 0), height: Math.min(8192, Number(metrics.height) || 0), firstFrameMs });
    }
    if (this.live && this.state.billing === 'active') this.keepServerAlive();
    return this.snapshot();
  }
  async endRemote() {
    clearInterval(this.watchdog); clearInterval(this.keepalive);
    if (!this.live) return;
    this.publish({ billing: 'ending' });
    // Best effort: tell the provider directly. The server hangup below is authoritative.
    try { if (this.live.control.type === 'vidu-ws' && this.socket?.readyState === 1) this.signal(5, { hangup: { hangup_reason: 'user_hangup' } }); } catch { /* ignore */ }
    let view = null;
    try { view = await this.backend.hangup(this.live.id); } catch { /* treated as unconfirmed */ }
    this.socket?.close(); this.socket = null;
    if (view?.state === 'ended' || view?.state === 'failed') {
      this.live = null;
      this.publish({ billing: 'ended', billedSeconds: view.billedSeconds ?? null, creditsCost: view.creditsCost ?? null, closeReason: view.closeReason || '', traceId: view.traceId || '' });
      void this.backend.refreshAccount?.().then(() => this.publish({})).catch(() => {});
      return;
    }
    this.publish({ billing: 'unknown', error: '本地已停止，但云端结束未确认，请重试结束。' });
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

module.exports = { CloudSession };
