const test = require('node:test');
const assert = require('node:assert/strict');
const { cropToPortrait, transitionAt, compareAt, ClipComposer, CLIP_TRANSITION_MS, CLIP_COMPARE_MS } = require('../app/clip-composer.js');

test('landscape sources are center-cropped to 9:16', () => {
  const crop = cropToPortrait(952, 544);
  assert.equal(crop.sh, 544); assert.equal(Math.round(crop.sw), 306); assert.equal(Math.round(crop.sx), 323); assert.equal(crop.sy, 0);
  const tall = cropToPortrait(720, 1600);
  assert.equal(tall.sw, 720); assert.equal(tall.sh, 1280); assert.equal(tall.sy, 160);
  assert.equal(cropToPortrait(0, 544), null);
});

test('transition starts with the teaser only and ends fully revealed', () => {
  assert.deepEqual(transitionAt(0), { silhouette: 1, source: 0, blur: 24, done: false });
  const mid = transitionAt(CLIP_TRANSITION_MS * 0.7);
  assert.ok(mid.source > 0 && mid.source < 1 && mid.blur > 0);
  assert.deepEqual(transitionAt(CLIP_TRANSITION_MS), { silhouette: 0, source: 1, blur: 0, done: true });
});

function fakeCanvas() {
  const calls = [];
  const context = new Proxy({}, { get: (_t, key) => (...args) => { calls.push([key, ...args]); return key === 'createLinearGradient' ? { addColorStop() {} } : undefined; }, set: (_t, key, value) => { calls.push(['set:' + String(key), value]); return true; } });
  return { canvas: { getContext: () => context }, calls };
}

test('frames always carry the AI label and brand corner; only given inputs are drawn', () => {
  const { canvas, calls } = fakeCanvas();
  const video = { videoWidth: 952, videoHeight: 544 };
  const result = new ClipComposer(canvas).render('cloud', video, null);
  assert.equal(result.source, 'cloud');
  assert.equal(canvas.width, 720); assert.equal(canvas.height, 1280);
  assert.deepEqual(calls.filter(c => c[0] === 'drawImage').map(c => c[1]), [video]);
  const texts = calls.filter(c => c[0] === 'fillText').map(c => c[1]);
  assert.ok(texts.includes('AI GENERATED · SoundFace')); assert.ok(texts.includes('SoundFace 声面'));
});

test('during the transition the reference image is drawn blurred before the generated picture', () => {
  const { canvas, calls } = fakeCanvas(); let time = 0;
  const composer = new ClipComposer(canvas, { now: () => time });
  const reference = { naturalWidth: 768, naturalHeight: 1024 }, video = { videoWidth: 952, videoHeight: 544 };
  composer.startTransition(); time = 100;
  composer.render('cloud', video, reference);
  const draws = calls.filter(c => c[0] === 'drawImage').map(c => c[1]);
  assert.deepEqual(draws, [reference], 'teaser only at the start');
  assert.ok(calls.some(c => c[0] === 'set:filter' && /blur\(28px\)/.test(c[1])));
  calls.length = 0; time = CLIP_TRANSITION_MS + 1;
  assert.equal(composer.render('cloud', video, reference).transition, false);
  assert.deepEqual(calls.filter(c => c[0] === 'drawImage').map(c => c[1]), [video]);
});

test('without a drawable source the clip shows a slate, never an image', () => {
  const { canvas, calls } = fakeCanvas();
  assert.equal(new ClipComposer(canvas).render('placeholder', null, null).source, 'placeholder');
  assert.equal(calls.filter(c => c[0] === 'drawImage').length, 0);
});

test('compare transition shows only the generic silhouette first, then wipes to the generated picture', () => {
  assert.deepEqual(compareAt(0), { wipe: 0, done: false });
  assert.ok(compareAt(CLIP_COMPARE_MS * 0.8).wipe > 0);
  assert.deepEqual(compareAt(CLIP_COMPARE_MS), { wipe: 1, done: true });
  const { canvas, calls } = fakeCanvas(); let time = 0;
  const composer = new ClipComposer(canvas, { now: () => time });
  const video = { videoWidth: 952, videoHeight: 544 }, reference = { naturalWidth: 768, naturalHeight: 1024 };
  composer.startTransition('compare'); time = 100;
  composer.render('cloud', video, reference);
  assert.equal(calls.filter(c => c[0] === 'drawImage').length, 0, 'built-in silhouette is vector-drawn, no image');
  assert.ok(calls.some(c => c[0] === 'fillText' && c[1] === 'BEFORE'));
  calls.length = 0; time = CLIP_COMPARE_MS * 0.8;
  composer.render('cloud', video, reference);
  assert.deepEqual(calls.filter(c => c[0] === 'drawImage').map(c => c[1]), [video]);
  const before = { naturalWidth: 720, naturalHeight: 1280 };
  calls.length = 0; composer.startTransition('compare'); time += 10;
  composer.render('cloud', video, reference, before);
  assert.deepEqual(calls.filter(c => c[0] === 'drawImage').map(c => c[1]), [before], 'replacement asset slot');
});
