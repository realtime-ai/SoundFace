const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Preserve the generated master; derive standard macOS sizes with system tools.
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'assets/icons/soundface-source.png');
const iconset = path.join(root, 'build/SoundFace.iconset');
fs.mkdirSync(iconset, { recursive: true });
for (const points of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = points * scale;
    execFileSync('sips', ['-z', String(pixels), String(pixels), source, '--out', path.join(iconset, `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'pipe' });
  }
}
fs.copyFileSync(path.join(iconset, 'icon_512x512@2x.png'), path.join(root, 'assets/icons/soundface.png'));
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'assets/icons/SoundFace.icns')]);
console.log('Built SoundFace PNG and ICNS (16–1024 px).');
