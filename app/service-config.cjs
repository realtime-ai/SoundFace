// App-owned service configuration. The client holds no provider API key: it
// only knows where the SoundFace server is. Development-only login is
// available exclusively in unpackaged builds and only when explicitly enabled.
function loadServiceConfig({ isPackaged, environment = process.env, packagedUrl = '' }) {
  const fromEnv = environment.SOUNDFACE_SERVER_URL;
  const candidate = !isPackaged && fromEnv ? fromEnv : isPackaged ? packagedUrl : 'http://127.0.0.1:8787';
  let baseUrl = '';
  try {
    const url = new URL(candidate);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local && !isPackaged)) baseUrl = url.origin;
  } catch { /* Unconfigured build: cloud features report unavailable. */ }
  const devUser = !isPackaged && /^[A-Za-z0-9_-]{2,32}$/.test(environment.SOUNDFACE_DEV_USER || '') ? environment.SOUNDFACE_DEV_USER : '';
  return { baseUrl, devUser };
}

module.exports = { loadServiceConfig };
