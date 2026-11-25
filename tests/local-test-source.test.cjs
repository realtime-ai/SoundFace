const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalTestSource } = require('../app/local-test-source.js');

test('local test frames visibly change and stop without accessing any media or cloud API', () => {
  let tick, time = 1000, sent = 0, cleared = 0; const labels = [], rects = [];
  const context = { fillRect: (...args) => rects.push(args), fillText: text => labels.push(text) };
  const canvas = { getContext: () => context };
  const source = new LocalTestSource(canvas, { now: () => time, schedule: fn => { tick = fn; return 7; }, unschedule: id => { assert.equal(id, 7); cleared++; } });
  source.start(frame => { assert.equal(frame, canvas); sent++; });
  assert.equal(canvas.width, 1280); assert.equal(canvas.height, 720);
  const firstMovingBox = rects.find(rect => rect[2] === 84);
  labels.length = 0; rects.length = 0; time = 1067; tick();
  assert.ok(labels.includes('FRAME 000002'));
  assert.notDeepEqual(rects.find(rect => rect[2] === 84), firstMovingBox);
  source.start(() => assert.fail('duplicate timer')); assert.equal(sent, 2);
  source.stop(); assert.equal(source.running, false); assert.equal(cleared, 1);
});
test('browser timer functions are not invoked with a custom receiver', t => {
  const originalSet = global.setInterval, originalClear = global.clearInterval;
  t.after(() => { global.setInterval = originalSet; global.clearInterval = originalClear; });
  global.setInterval = function(tick, period) { 'use strict'; assert.equal(this, undefined); assert.equal(period, 67); return 7; };
  global.clearInterval = function(timer) { 'use strict'; assert.equal(this, undefined); assert.equal(timer, 7); };
  const context = { fillRect() {}, fillText() {} };
  const source = new LocalTestSource({ getContext: () => context });
  source.start(() => {}); source.stop();
});
