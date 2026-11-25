const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CharacterLibrary, validateReference } = require('../app/characters.cjs');
const reference = path.resolve(__dirname, '../assets/default-character.jpg');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soundface-characters-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { directory: path.join(directory, 'library'), defaultImage: reference, normalize: data => ({ image: data, thumbnail: 'data:image/jpeg;base64,/9j/2Q==' }), trash: async folder => fs.renameSync(folder, path.join(directory, 'trashed')) };
  const file = path.join(directory, 'My Character.jpg'); fs.copyFileSync(reference, file);
  return { directory, options, file, library: new CharacterLibrary(options) };
}
test('imported reference survives restart and is actually resolved by its character ID', t => {
  const f = fixture(t), item = f.library.importFile(f.file);
  assert.equal(item.name, 'My Character'); assert.equal(item.source, 'custom');
  const reloaded = new CharacterLibrary(f.options);
  assert.equal(reloaded.list().length, 2); assert.ok(reloaded.has(item.id));
  assert.equal(reloaded.image(item.id), 'data:image/jpeg;base64,' + fs.readFileSync(reference).toString('base64'));
  assert.ok(!JSON.stringify(reloaded.list()).includes(f.directory));
  assert.throws(() => reloaded.image('../reference.jpg'), /不可用/);
});
test('removal moves the app copy to trash and preserves the original image', async t => {
  const f = fixture(t), item = f.library.importFile(f.file);
  await f.library.remove(item.id);
  assert.equal(f.library.has(item.id), false); assert.ok(fs.existsSync(f.file));
  assert.ok(fs.existsSync(path.join(f.directory, 'trashed/reference.jpg')));
  await assert.rejects(f.library.remove('qinghe'), /只能移除/);
});
test('malformed and oversized images are rejected before the native decoder is called', t => {
  const f = fixture(t); let decoded = false; f.library.normalize = () => { decoded = true; };
  fs.writeFileSync(f.file, Buffer.from('not an image'));
  assert.throws(() => f.library.importFile(f.file), /有效的 JPG/); assert.equal(decoded, false);
  const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR',12); png.writeUInt32BE(100000,16); png.writeUInt32BE(100000,20);
  assert.throws(() => validateReference(png), /128–4096/);
  assert.throws(() => validateReference(Buffer.alloc(4 * 1024 * 1024 + 1)), /4 MB/);
});
test('tampered metadata and symlink folders cannot become selectable characters', t => {
  const f = fixture(t), item = f.library.importFile(f.file);
  const metaPath = path.join(f.options.directory, item.id, 'character.json');
  fs.writeFileSync(metaPath, JSON.stringify({ name: 'External', thumbnail: 'file:///private/test.jpg' }));
  const symlink = 'custom-00000000-0000-0000-0000-000000000000';
  fs.symlinkSync(f.directory, path.join(f.options.directory, symlink));
  const reloaded = new CharacterLibrary(f.options);
  assert.deepEqual(reloaded.list().map(item => item.id), ['qinghe']);
});
test('built-in characters come from the manifest and resolve to their own files', t => {
  const { loadBuiltinManifest } = require('../app/characters.cjs');
  const assets = path.resolve(__dirname, '../assets');
  const builtins = loadBuiltinManifest(path.join(assets, 'characters/manifest.json'), assets);
  assert.ok(builtins.length >= 2); assert.equal(builtins[0].id, 'qinghe');
  const f = fixture(t), library = new CharacterLibrary({ ...f.options, builtins });
  for (const item of builtins) {
    assert.ok(library.has(item.id));
    assert.equal(library.image(item.id), 'data:image/jpeg;base64,' + fs.readFileSync(item.file).toString('base64'));
    assert.ok(fs.existsSync(path.join(assets, item.thumbnail.replace('../assets/', ''))), item.thumbnail);
  }
  assert.deepEqual(library.list().filter(item => item.source === 'builtin').map(item => item.id), builtins.map(item => item.id));
  assert.ok(!JSON.stringify(library.list()).includes(assets), 'no absolute paths over IPC');
});
test('manifest entries cannot escape assets/ or collide with custom IDs', t => {
  const { loadBuiltinManifest } = require('../app/characters.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soundface-manifest-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const assets = path.join(directory, 'assets'); fs.mkdirSync(path.join(assets, 'characters'), { recursive: true });
  fs.copyFileSync(reference, path.join(assets, 'characters/ok.jpg'));
  fs.writeFileSync(path.join(assets, 'characters/manifest.json'), JSON.stringify({ characters: [
    { id: 'ok', name: '好', file: 'ok.jpg' }, { id: 'ok', name: '重复', file: 'ok.jpg' },
    { id: 'escape', name: '越界', file: '../../secret.jpg' }, { id: 'custom-00000000-0000-0000-0000-000000000000', name: '冒充', file: 'ok.jpg' },
    { id: 'notimage', name: '非图片', file: 'manifest.json' }, { id: 'Bad ID', name: '坏', file: 'ok.jpg' }
  ] }));
  assert.deepEqual(loadBuiltinManifest(path.join(assets, 'characters/manifest.json'), assets).map(item => item.id), ['ok']);
});
test('without a manifest the library still offers the original default character', t => {
  const f = fixture(t);
  assert.deepEqual(f.library.list().filter(item => item.source === 'builtin').map(item => item.id), ['qinghe']);
  assert.ok(f.library.image('qinghe').startsWith('data:image/jpeg;base64,'));
});
