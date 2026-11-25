const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_BYTES = 4 * 1024 * 1024;
const customID = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function dimensions(data) {
  if (data.length > MAX_BYTES) throw new Error('参考图不能超过 4 MB。');
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 3 < data.length) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
      offset += length;
    }
  }
  throw new Error('请选择有效的 JPG 或 PNG 图片。');
}
function validateReference(data) {
  const { width, height } = dimensions(data);
  if (Math.min(width, height) < 128 || Math.max(width, height) > 4096 || width * height > 16_000_000 || width / height < 0.25 || width / height > 4) throw new Error('图片边长需为 128–4096 像素，长宽比不超过 4:1。');
  return { width, height };
}
const builtinID = /^[a-z][a-z0-9-]{1,31}$/;
// Built-in characters come from assets/characters/manifest.json, so adding or
// removing one only touches assets and the manifest. Files must stay in assets/.
function loadBuiltinManifest(manifestPath, assetsRoot) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const root = path.resolve(assetsRoot), seen = new Set(), result = [];
  for (const item of Array.isArray(manifest.characters) ? manifest.characters : []) {
    if (!item || !builtinID.test(item.id) || seen.has(item.id) || customID.test(item.id)) continue;
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 20 || typeof item.file !== 'string') continue;
    const file = path.resolve(path.dirname(manifestPath), item.file);
    if (!file.startsWith(root + path.sep) || !/\.(jpe?g|png)$/i.test(file)) continue;
    seen.add(item.id);
    result.push({ id: item.id, name: item.name.trim(), file, thumbnail: '../assets/' + path.relative(root, file).split(path.sep).join('/'),
      tag: typeof item.tag === 'string' ? item.tag.slice(0, 20) : '', description: typeof item.description === 'string' ? item.description.slice(0, 80) : '保留你的动作与表情。' });
  }
  return result;
}
class CharacterLibrary {
  constructor({ directory, defaultImage, normalize, trash, builtins }) {
    Object.assign(this, { directory, defaultImage, normalize, trash });
    // Without a manifest, fall back to the single original default character.
    this.builtins = new Map((builtins && builtins.length ? builtins : [{ id: 'qinghe', name: '青禾', file: defaultImage, thumbnail: '../assets/default-character.jpg', tag: '', description: '自然、清爽的出镜身份，保留你的动作与表情。' }]).map(item => [item.id, item]));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.records = new Map(); this.reload();
  }
  reload() {
    this.records.clear();
    for (const id of fs.readdirSync(this.directory).filter(id => customID.test(id))) {
      try {
        const folder = path.join(this.directory, id);
        if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) continue;
        const metaPath = path.join(folder, 'character.json'), imagePath = path.join(folder, 'reference.jpg');
        if (!fs.lstatSync(metaPath).isFile() || fs.lstatSync(metaPath).isSymbolicLink() || fs.statSync(metaPath).size > 150000) continue;
        if (!fs.lstatSync(imagePath).isFile() || fs.lstatSync(imagePath).isSymbolicLink() || fs.statSync(imagePath).size > MAX_BYTES) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (typeof meta.name !== 'string' || !meta.name.trim() || meta.name.length > 40 || typeof meta.thumbnail !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(meta.thumbnail)) continue;
        validateReference(fs.readFileSync(imagePath));
        this.records.set(id, { id, name: meta.name, thumbnail: meta.thumbnail, source: 'custom', description: '使用你的参考图，跟随镜头中的动作与表情。' });
      } catch { /* Ignore incomplete or invalid local records. */ }
    }
  }
  list() { return [...[...this.builtins.values()].map(({ id, name, thumbnail, tag, description }) => ({ id, name, thumbnail, tag, description, source: 'builtin' })), ...this.records.values()]; }
  has(id) { return this.builtins.has(id) || this.records.has(id); }
  image(id) {
    if (!this.has(id)) throw new Error('该角色不可用，请重新选择。');
    const builtin = this.builtins.get(id), file = builtin ? builtin.file : path.join(this.directory, id, 'reference.jpg');
    const data = fs.readFileSync(file); validateReference(data);
    const png = data.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]));
    return `data:image/${png ? 'png' : 'jpeg'};base64,` + data.toString('base64');
  }
  importFile(file) {
    if (this.records.size >= 12) throw new Error('最多保存 12 个自定义角色，请先移除不需要的角色。');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('请选择 4 MB 以内的 JPG 或 PNG 图片。');
    const data = fs.readFileSync(file), size = validateReference(data), normalized = this.normalize(data, size);
    validateReference(normalized.image);
    const id = 'custom-' + randomUUID(), name = path.basename(file, path.extname(file)).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 24) || '自定义角色';
    const folder = path.join(this.directory, id); fs.mkdirSync(folder, { mode: 0o700 });
    try {
      fs.writeFileSync(path.join(folder, 'reference.jpg'), normalized.image, { mode: 0o600 });
      fs.writeFileSync(path.join(folder, 'character.json'), JSON.stringify({ name, thumbnail: normalized.thumbnail }), { mode: 0o600 });
    } catch (error) { fs.rmSync(folder, { recursive: true, force: true }); throw error; }
    this.reload(); return this.records.get(id);
  }
  async remove(id) {
    if (!customID.test(id) || !this.records.has(id)) throw new Error('只能移除自己的参考图角色。');
    await this.trash(path.join(this.directory, id)); this.records.delete(id); return this.list();
  }
}
module.exports = { CharacterLibrary, validateReference, loadBuiltinManifest };
