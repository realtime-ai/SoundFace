const { packager } = require('@electron/packager');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadCloudKey } = require('../app/service-config.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-icon.cjs')], { stdio: 'inherit' });
  // Stage an explicit source allowlist; app-owned runtime service configuration is injected separately.
  const stage = path.join(root, 'build/app-stage');
  await fs.rm(stage, { recursive: true, force: true }); await fs.mkdir(stage, { recursive: true });
  await fs.cp(path.join(root, 'app'), path.join(stage, 'app'), { recursive: true });
  await fs.mkdir(path.join(stage, 'assets'));
  await fs.copyFile(path.join(root, 'assets/default-character.jpg'), path.join(stage, 'assets/default-character.jpg'));
  await fs.mkdir(path.join(stage, 'assets/icons'));
  await fs.copyFile(path.join(root, 'assets/icons/soundface.png'), path.join(stage, 'assets/icons/soundface.png'));
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'soundface', version: '0.1.0', main: 'app/main.cjs', private: true }));
  const serviceKey = loadCloudKey(path.join(root, '.soundface-local/cloud.json'));
  const serviceConfig = path.join(root, 'build/cloud-runtime.json');
  await fs.rm(serviceConfig, { force: true });
  if (serviceKey) await fs.writeFile(serviceConfig, JSON.stringify({ apiKey: serviceKey }), { mode: 0o644 });
  const [folder] = await packager({ dir: stage, out: path.join(root, 'dist'), name: 'SoundFace', executableName: 'SoundFace', appBundleId: 'app.soundface.desktop', appVersion: '0.1.0', buildVersion: '1', platform: 'darwin', arch: process.arch, electronVersion: require('../package.json').devDependencies.electron, overwrite: true, asar: true, prune: false,
    icon: path.join(root, 'assets/icons/SoundFace.icns'),
    extendInfo: { LSMinimumSystemVersion: '13.0', NSMicrophoneUsageDescription: '将所选麦克风的声音发送到 SoundFace 虚拟麦克风，供会议与录制软件使用。', NSCameraUsageDescription: '预览所选摄像头，并在你主动开启云端会话时生成虚拟形象。', NSSystemExtensionUsageDescription: '提供 SoundFace Camera 虚拟摄像头。' },
    extraResource: [...(serviceKey ? [serviceConfig] : []), path.join(root, 'build/soundface-audio'), path.join(root, 'build/soundface-video'), path.join(root, 'build/soundface-camera.node'), path.join(root, 'dist/SoundFace-Microphone-dev.pkg'), path.join(root, 'docs/DEVELOPMENT.md'), path.join(root, 'dist/BlackHole-LICENSE'), path.join(root, 'dist/BlackHole-source.tar.gz'), path.join(root, 'native/audio/SoundFaceConfig.h')]
  });
  const appPath = path.join(folder, 'SoundFace.app');
  const extensionPath = path.join(appPath, 'Contents/Library/SystemExtensions/app.soundface.camera.systemextension');
  await fs.mkdir(path.dirname(extensionPath), { recursive: true });
  await fs.cp(path.join(root, 'build/app.soundface.camera.systemextension'), extensionPath, { recursive: true });
  // Development signing only. Release builds require proper inside-out team signing and notarization.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', path.join(root, 'native/camera/Camera.entitlements'), extensionPath], { stdio: 'inherit' });
  // Restricted installation entitlements prevent an ad-hoc host from launching
  // under normal AMFI policy. The separate camera-test artifact adds them.
  execFileSync('codesign', ['--force', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  const pkgRoot = path.join(root, 'build/desktop-pkg-root');
  await fs.rm(pkgRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(pkgRoot, 'Applications'), { recursive: true });
  execFileSync('ditto', [appPath, path.join(pkgRoot, 'Applications/SoundFace.app')]);
  const plist = path.join(root, 'build/app-components.plist');
  execFileSync('pkgbuild', ['--analyze', '--root', pkgRoot, plist]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :0:BundleIsRelocatable false', plist]);
  execFileSync('pkgbuild', ['--root', pkgRoot, '--component-plist', plist, '--identifier', 'app.soundface.desktop.installer', '--version', '0.1.0', '--install-location', '/', path.join(root, 'dist/SoundFace-Desktop-dev.pkg')], { stdio: 'inherit' });
  console.log('Development app:', appPath);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
