const fs = require('node:fs');

// App-owned configuration only. Never expose this object through IPC.
function loadCloudKey(file, environment = process.env) {
  let key = environment.VIDU_API_KEY;
  if (!key && file) {
    try {
      if (fs.statSync(file).size <= 4096) key = JSON.parse(fs.readFileSync(file, 'utf8')).apiKey;
    } catch { /* A build without service configuration remains usable locally. */ }
  }
  return typeof key === 'string' && /^vda_[A-Za-z0-9_]{20,200}$/.test(key.trim()) ? key.trim() : '';
}

module.exports = { loadCloudKey };
