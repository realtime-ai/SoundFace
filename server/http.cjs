'use strict';
// HTTP API (node:http only).
//   POST /v1/auth/:method/code       → { resendAfterSeconds }  (sms)
//   POST /v1/auth/:method/login      → { token, account }
//   GET  /v1/me                      → account (quota, remaining, active session)
//   POST /v1/sessions  { image }     → { sessionId, provider, transport, control }
//   POST /v1/sessions/:id/heartbeat  → session view
//   POST /v1/sessions/:id/hangup     → session view (after upstream confirmation)
//   GET  /v1/sessions/:id            → session view
const http = require('node:http');
const { ServiceError } = require('./service.cjs');
const MAX_BODY = 6 * 1024 * 1024; // Reference images are ≤ 4 MB before base64.

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    request.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(new ServiceError(413, 'BODY_TOO_LARGE', '请求过大')); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ServiceError(400, 'BAD_JSON', '请求格式无效')); } });
    request.on('error', reject);
  });
}

function createHandler(service) {
  return async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      const url = new URL(request.url, 'http://local'), parts = url.pathname.split('/').filter(Boolean), method = request.method;
      const bearer = () => service.authenticate((request.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'auth' && parts[3] === 'login' && parts.length === 4) return send(200, await service.login(parts[2], await readJson(request)));
      if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'auth' && parts[3] === 'code' && parts.length === 4) return send(200, await service.requestCode(parts[2], await readJson(request)));
      if (method === 'GET' && url.pathname === '/v1/me') return send(200, service.account(bearer()));
      if (method === 'POST' && url.pathname === '/v1/sessions') {
        const user = bearer(), body = await readJson(request);
        if (typeof body.image !== 'string' || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(body.image)) throw new ServiceError(400, 'BAD_IMAGE', '参考图无效');
        return send(200, await service.createSession(user, { image: body.image }));
      }
      if (parts[0] === 'v1' && parts[1] === 'sessions' && parts[2]) {
        const user = bearer(), id = parts[2];
        if (method === 'GET' && parts.length === 3) return send(200, service.view(service.own(user, id).id));
        if (method === 'POST' && parts[3] === 'heartbeat' && parts.length === 4) return send(200, service.heartbeat(user, id));
        if (method === 'POST' && parts[3] === 'hangup' && parts.length === 4) return send(200, await service.hangup(user, id));
      }
      send(404, { code: 'NOT_FOUND', message: '接口不存在' });
    } catch (error) {
      if (error instanceof ServiceError || error.status) send(error.status || 400, { code: error.code || 'BAD_REQUEST', message: error.message });
      else { console.error('[soundface-server]', error); send(500, { code: 'INTERNAL', message: '服务内部错误' }); }
    }
  };
}

function createServer(service) { return http.createServer(createHandler(service)); }

module.exports = { createServer, createHandler };
