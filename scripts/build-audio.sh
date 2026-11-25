#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REV=561d934c77a1fa64987e01ccabe890fed30e181f
SOURCE="$ROOT/.cache/BlackHole"
if [ ! -d "$SOURCE/.git" ]; then
  mkdir -p "$ROOT/.cache"
  git clone https://github.com/ExistentialAudio/BlackHole.git "$SOURCE"
fi
if [ "$(git -C "$SOURCE" rev-parse HEAD)" != "$REV" ]; then
  git -C "$SOURCE" fetch origin "$REV"
  git -C "$SOURCE" checkout --detach "$REV"
fi
if [ -n "$(git -C "$SOURCE" status --porcelain)" ]; then
  echo 'Cached BlackHole source is modified. Preserve changes and use a clean cache.' >&2
  exit 1
fi
BUNDLE="$ROOT/build/SoundFace.driver"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
xcrun clang -O2 -fblocks -bundle -arch arm64 -arch x86_64 \
  -mmacosx-version-min=12.3 -include "$ROOT/native/audio/SoundFaceConfig.h" \
  "$SOURCE/BlackHole/BlackHole.c" -framework CoreAudio -framework CoreFoundation \
  -framework Accelerate -o "$BUNDLE/Contents/MacOS/SoundFace"
python3 "$ROOT/scripts/audio-plist.py" "$SOURCE" "$BUNDLE"
cp "$SOURCE/BlackHole/BlackHole.icns" "$BUNDLE/Contents/Resources/SoundFace.icns"
cp "$SOURCE/LICENSE" "$BUNDLE/Contents/Resources/BlackHole-LICENSE"
codesign --force --sign "${SOUNDFACE_SIGN_IDENTITY:--}" "$BUNDLE"
codesign --verify --strict "$BUNDLE"
mkdir -p "$ROOT/build/audio-pkg-root/Library/Audio/Plug-Ins/HAL" "$ROOT/dist"
ditto "$BUNDLE" "$ROOT/build/audio-pkg-root/Library/Audio/Plug-Ins/HAL/SoundFace.driver"
# HAL .driver bundles are payload files, not relocatable application components.
pkgbuild --root "$ROOT/build/audio-pkg-root" --identifier app.soundface.audio.installer \
  --version 0.1.0 --install-location / "$ROOT/dist/SoundFace-Microphone-dev.pkg"
git -C "$SOURCE" archive --format=tar.gz --prefix=BlackHole/ "$REV" > "$ROOT/dist/BlackHole-source.tar.gz"
cp "$ROOT/native/audio/SoundFaceConfig.h" "$ROOT/dist/SoundFaceConfig.h"
cp "$SOURCE/LICENSE" "$ROOT/dist/BlackHole-LICENSE"
echo 'Built development package. Not notarized. Installation may require restart; no audio service is restarted by this script.'
