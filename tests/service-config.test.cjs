const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCloudKey } = require('../app/service-config.cjs');

test('app-owned service configuration loads automatically and allows a developer environment override', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soundface-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'cloud.json');
  // Deliberately synthetic; no service credentials in source or test artifacts.
  const configured = 'vda_' + 'x'.repeat(24), override = 'vda_' + 'y'.repeat(24);
  fs.writeFileSync(file, JSON.stringify({ apiKey: configured }));
  assert.equal(loadCloudKey(file, {}), configured);
  assert.equal(loadCloudKey(file, { VIDU_API_KEY: override }), override);
});

test('missing, malformed, or oversized service configuration fails closed without echoing its contents', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soundface-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'cloud.json');
  assert.equal(loadCloudKey(file, {}), '');
  for (const content of ['invalid json', JSON.stringify({ apiKey: 'invalid' }), 'x'.repeat(4097)]) {
    fs.writeFileSync(file, content);
    assert.equal(loadCloudKey(file, {}), '');
  }
});
