'use strict';
// Development entry: `node server/index.cjs`
//   PORT (default 8787), SOUNDFACE_DATA (default .soundface-local/server.json)
//   SOUNDFACE_DEV_LOGIN=1            enable development logins (name login; SMS login with fixed code 000000, nothing sent)
//   SOUNDFACE_PROVIDER=fake|vidu      default fake (no network, no cost)
//   SOUNDFACE_ALLOW_PAID=1 + VIDU_API_KEY   both required for the paid provider
//   SOUNDFACE_DEFAULT_QUOTA (seconds, default 600)
const path = require('node:path');
const { JsonStore } = require('./store.cjs');
const { SessionService } = require('./service.cjs');
const { createServer } = require('./http.cjs');
const { DevAuthenticator, SmsAuthenticator, DevSmsSender } = require('./auth.cjs');
const { FakeProvider } = require('./providers/fake.cjs');

function provider(env) {
  if ((env.SOUNDFACE_PROVIDER || 'fake') === 'fake') return new FakeProvider();
  if (env.SOUNDFACE_PROVIDER === 'vidu') {
    if (env.SOUNDFACE_ALLOW_PAID !== '1') throw new Error('真实生成服务会产生费用：需要同时设置 SOUNDFACE_ALLOW_PAID=1');
    const { ViduProvider } = require('./providers/vidu.cjs');
    return new ViduProvider({ key: env.VIDU_API_KEY });
  }
  throw new Error('未知的 SOUNDFACE_PROVIDER');
}

if (require.main === module) {
  const env = process.env, root = path.join(__dirname, '..');
  const service = new SessionService({
    store: new JsonStore(env.SOUNDFACE_DATA || path.join(root, '.soundface-local/server.json')),
    provider: provider(env),
    authenticators: env.SOUNDFACE_DEV_LOGIN === '1' ? [new DevAuthenticator(), new SmsAuthenticator({ sender: new DevSmsSender() })] : [],
    defaultQuotaSeconds: Number(env.SOUNDFACE_DEFAULT_QUOTA) || 600
  });
  const port = Number(env.PORT) || 8787;
  createServer(service).listen(port, '127.0.0.1', () => console.log(`SoundFace server · provider=${service.provider.name} · dev-login=${env.SOUNDFACE_DEV_LOGIN === '1'} · http://127.0.0.1:${port}`));
  setInterval(() => { void service.reap().catch(error => console.error('[reaper]', error.message)); }, 10000).unref();
}

module.exports = { provider };
