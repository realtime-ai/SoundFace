// Starts a real local `wrangler dev` (workerd + local D1 + Durable Objects) with its own state.
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ask the OS for a free port; also safe when the suite is invoked independently.
export const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

export async function startWorker(vars) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-workers-test-'));
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], { cwd: ROOT, stdio: 'pipe' });
  const server = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--persist-to', state, ...Object.entries({ DEV_LOGIN: '1', ALLOW_PAID: '0', PROVIDER: 'fake', ...vars }).flatMap(([key, value]) => ['--var', `${key}:${value}`])], { cwd: ROOT, stdio: 'ignore', detached: true });
  let up = false;
  // Cold starts (first run, several files starting at once) can take a while.
  for (let i = 0; i < 180 && !up; i++) { try { up = (await fetch(base + '/v1/plans')).ok; } catch { /* starting */ } if (!up) await sleep(500); }
  const stop = () => { try { process.kill(-server.pid); } catch { /* gone */ } fs.rmSync(state, { recursive: true, force: true }); };
  if (!up) { stop(); throw new Error('wrangler dev did not start'); }
  const call = async (method, route, body, token) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (...args) => { const result = await call(...args); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  return {
    base, call, ok,
    d1: sql => execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', state, '--command', sql], { cwd: ROOT, stdio: 'pipe' }),
    query: sql => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', state, '--json', '--command', sql], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' })).flatMap(item => item.results || []),
    login: async email => { await ok('POST', '/v1/auth/email/code', { email }); return ok('POST', '/v1/auth/email/login', { email, code: '000000' }); },
    stop
  };
}
