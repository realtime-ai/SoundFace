// Admin console page: plain static files from the repo-root admin/ directory
// (Workers static assets, binding ASSETS). `run_worker_first` sends every
// request to the worker first, so the files are only reachable through the two
// entry points below. No Cloudflare-only imports, so tests can load this file.
import { json } from './util.js';

const ADMIN_HOST = 'admin.dot.cc';
const PAGE_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache'
};
export function adminPagePath(url, env) {
  if (/^\/(v1|admin\/v1)(\/|$)/.test(url.pathname)) return null;                 // API, on any host
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return url.pathname.slice(6) || '/';
  return url.hostname === (env.ADMIN_HOST || ADMIN_HOST) ? url.pathname : null;
}
export async function serveAdminPage(request, env, url, path) {
  if (url.pathname === '/admin') return Response.redirect(new URL('/admin/', url).toString(), 301);
  if (!env.ASSETS || !['GET', 'HEAD'].includes(request.method)) return json(404, { code: 'NOT_FOUND', message: '页面不存在' });
  const asset = await env.ASSETS.fetch(new Request(new URL(path === '/' ? '/index.html' : path, url.origin), { method: request.method }));
  if (!asset.ok) return new Response('页面不存在', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const response = new Response(asset.body, asset);
  for (const [key, value] of Object.entries(PAGE_HEADERS)) response.headers.set(key, value);
  return response;
}
