'use strict';
// Minimal JSON-file store (no runtime dependencies). Writes are atomic
// (temp file + rename). Swap for a real database before multi-instance use.
const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = { users: {}, tokens: {}, sessions: {} };
    if (file && fs.existsSync(file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  user(id) { return this.data.users[id] || null; }
  upsertUser(user) { this.data.users[user.id] = { ...this.data.users[user.id], ...user }; this.save(); return this.data.users[user.id]; }
  tokenUser(token) { const record = this.data.tokens[token]; return record ? this.user(record.userId) : null; }
  addToken(token, userId, now) { this.data.tokens[token] = { userId, createdAt: now }; this.save(); }
  session(id) { return this.data.sessions[id] || null; }
  putSession(session) { this.data.sessions[session.id] = session; this.save(); return session; }
  sessions(filter = () => true) { return Object.values(this.data.sessions).filter(filter); }
}

module.exports = { JsonStore };
