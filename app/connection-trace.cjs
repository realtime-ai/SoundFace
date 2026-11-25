const rules = {
  'attempt-start': /^(auto|tcp)$/,
  'rtc-joined': /^ok$/,
  'video-publish': /^\d+(?:-\d+){0,3}$/,
  'rtc-connection': /^\d+(?:-\d+){0,3}$/,
  'render-online': /^ok$/,
  'render-offline': /^\d{1,6}$/,
  'render-subscription': /^\d{1,3}$/,
  'first-frame': /^ok$/,
  'start-error': /^(Error|TypeError|AbortError|NotAllowedError|NotReadableError|ERR_[A-Z0-9_]{1,48}|\d{1,10})$/,
  'stop': /^(user_stop|rtc-bye-\d{1,8})$/
};
class ConnectionTrace {
  constructor(now = Date.now) { this.now = now; this.events = []; }
  record({ stage, code }) {
    code = String(code ?? '');
    if (!Object.hasOwn(rules, stage) || !rules[stage].test(code)) return false;
    if (stage === 'attempt-start') this.events = [];
    const last = this.events.at(-1);
    if (last?.stage === stage && last.code === code) return false;
    this.events.push({ at: this.now(), stage, code });
    this.events = this.events.slice(-32); return true;
  }
  snapshot() { return this.events.map(item => ({ ...item })); }
}
module.exports = { ConnectionTrace };
