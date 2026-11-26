// SoundFace API (Cloudflare Workers). Same contract as the old node server, plus credits:
//   POST /v1/auth/:method/code        { phone | email }          → { resendAfterSeconds, devHint? }
//   POST /v1/auth/:method/login       { phone | email, code } | { name } (dev) → { token, account }
//   GET  /v1/me                                                  → account
//   GET  /v1/plans                                               → { plans, purchaseHint }
//   POST /v1/redeem                   { code }                   → { credits, account }
//   GET  /v1/history                                             → { purchases, sessions }
//   POST /v1/sessions                 { image }                  → { sessionId, provider, transport, control }
//   POST /v1/sessions/:id/heartbeat   { frames }                 → session view
//   POST /v1/sessions/:id/hangup                                 → session view (after upstream confirmation)
//   GET  /v1/sessions/:id                                        → session view
// Admin console: API under /admin/v1/... (src/admin.js, admin allowlist on every
// request) and the page itself (repo-root admin/, served as static assets) at
// /admin/ on any host, or at / on the admin host (admin.dot.cc in production).
import { ServiceError, fail, json, sha256, randomToken, intVar, readJson } from './util.js';
import { loginMethods, authenticate } from './auth.js';
import { adminRoute } from './admin.js';
import { adminPagePath, serveAdminPage } from './pages.js';
import { PLANS, PURCHASE_HINT } from './plans.js';
export { AccountObject } from './account.js';

async function account(env, userId, method, arg) {
  const result = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(userId)).call(method, arg);
  if (!result.ok) throw new ServiceError(result.status, result.code, result.message);
  return result.value;
}

async function route(request, env) {
  const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean), method = request.method, now = Date.now();
  if (parts[0] === 'admin' && parts[1] === 'v1') return adminRoute(request, env, parts.slice(2), url);
  if (parts[0] !== 'v1') fail(404, 'NOT_FOUND', '接口不存在');
  if (parts[1] === 'auth' && parts.length === 4 && method === 'POST') {
    const authenticator = loginMethods(env, () => Date.now()).get(parts[2]);
    if (!authenticator || (parts[3] === 'code' && !authenticator.requestCode)) fail(404, 'LOGIN_METHOD_UNAVAILABLE', '该登录方式不可用');
    const body = await readJson(request);
    if (parts[3] === 'code') return authenticator.requestCode(body);
    if (parts[3] !== 'login') fail(404, 'NOT_FOUND', '接口不存在');
    const { accountId, name } = await authenticator.verify(body);
    await env.DB.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name').bind(accountId, name, now).run();
    const token = randomToken();
    await env.DB.prepare('INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)').bind(await sha256(token), accountId, now).run();
    return { token, account: await account(env, accountId, 'ensure', { id: accountId, name, trialSeconds: Math.max(0, intVar(env.TRIAL_SECONDS, 0)) }) };
  }
  if (url.pathname === '/v1/plans' && method === 'GET') return { plans: PLANS, purchaseHint: PURCHASE_HINT };
  const userId = await authenticate(request, env);
  if (url.pathname === '/v1/me' && method === 'GET') return account(env, userId, 'account');
  if (url.pathname === '/v1/history' && method === 'GET') return account(env, userId, 'history');
  if (url.pathname === '/v1/redeem' && method === 'POST') return account(env, userId, 'redeem', { code: String((await readJson(request)).code || '').slice(0, 64) });
  if (url.pathname === '/v1/sessions' && method === 'POST') {
    const body = await readJson(request);
    if (typeof body.image !== 'string' || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(body.image)) fail(400, 'BAD_IMAGE', '这张图片打不开，请换一张 JPG 或 PNG 图片。');
    return account(env, userId, 'createSession', { image: body.image });
  }
  if (parts[1] === 'sessions' && parts[2]) {
    const sessionId = parts[2];
    if (method === 'GET' && parts.length === 3) return account(env, userId, 'view', { sessionId });
    if (method === 'POST' && parts[3] === 'heartbeat' && parts.length === 4) return account(env, userId, 'heartbeat', { sessionId, frames: Number((await readJson(request)).frames) || 0 });
    if (method === 'POST' && parts[3] === 'hangup' && parts.length === 4) return account(env, userId, 'hangup', { sessionId });
  }
  fail(404, 'NOT_FOUND', '接口不存在');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), page = adminPagePath(url, env);
    if (page != null) return serveAdminPage(request, env, url, page);
    try { return json(200, await route(request, env)); }
    catch (error) {
      if (error instanceof ServiceError) return json(error.status, { code: error.code, message: error.message });
      console.error('[soundface-api]', error); return json(500, { code: 'INTERNAL', message: '服务内部错误' });
    }
  }
};
