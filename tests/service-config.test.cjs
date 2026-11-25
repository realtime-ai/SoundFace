const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServiceConfig } = require('../app/service-config.cjs');

test('development builds default to the local server and accept an override', () => {
  assert.deepEqual(loadServiceConfig({ isPackaged: false, environment: {} }), { baseUrl: 'http://127.0.0.1:8787', devUser: '' });
  assert.equal(loadServiceConfig({ isPackaged: false, environment: { SOUNDFACE_SERVER_URL: 'https://api.example.com/x' } }).baseUrl, 'https://api.example.com');
  assert.equal(loadServiceConfig({ isPackaged: false, environment: { SOUNDFACE_SERVER_URL: 'http://evil.example.com' } }).baseUrl, '', 'plain http only for localhost');
});

test('packaged builds ignore environment overrides and never enable the development login', () => {
  const environment = { SOUNDFACE_SERVER_URL: 'http://127.0.0.1:8787', SOUNDFACE_DEV_USER: 'tester' };
  assert.deepEqual(loadServiceConfig({ isPackaged: true, environment }), { baseUrl: '', devUser: '' });
  assert.equal(loadServiceConfig({ isPackaged: true, environment, packagedUrl: 'https://api.soundface.example' }).baseUrl, 'https://api.soundface.example');
  assert.equal(loadServiceConfig({ isPackaged: false, environment }).devUser, 'tester');
  assert.equal(loadServiceConfig({ isPackaged: false, environment: { SOUNDFACE_DEV_USER: '../x' } }).devUser, '');
});

test('the client configuration carries no provider key', () => {
  const config = loadServiceConfig({ isPackaged: false, environment: { VIDU_API_KEY: 'vda_' + 'x'.repeat(24) } });
  assert.ok(!JSON.stringify(config).includes('vda_'));
});
