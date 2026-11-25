#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/build/app.soundface.camera.systemextension"
mkdir -p "$BUNDLE/Contents/MacOS"
xcrun swiftc -O -target "$(uname -m)-apple-macosx12.3" "$ROOT/native/camera/main.swift" "$ROOT/native/camera/FrameStore.swift" "$ROOT/native/camera/CameraSink.swift" \
  -framework CoreMediaIO -framework CoreMedia -framework CoreVideo -framework CoreAudio \
  -o "$BUNDLE/Contents/MacOS/SoundFaceCamera"
cp "$ROOT/native/camera/Info.plist" "$BUNDLE/Contents/Info.plist"
codesign --force --sign - --entitlements "$ROOT/native/camera/Camera.entitlements" "$BUNDLE"
codesign --verify --strict "$BUNDLE"
echo 'Camera Extension compiled. Ad-hoc signed only; Apple team signing and activation remain unverified.'

xcrun swiftc -O -target "$(uname -m)-apple-macosx13.0" "$ROOT/native/video/GeneratedFrame.swift" "$ROOT/native/video/VideoBridge.swift" \
  -framework AVFoundation -framework CoreMediaIO -framework CoreMedia -framework CoreVideo -framework CoreImage -framework ImageIO \
  -o "$ROOT/build/soundface-video"
codesign --force --sign "${SOUNDFACE_SIGN_IDENTITY:--}" --identifier app.soundface.video "$ROOT/build/soundface-video"

# Stable Node-API (no V8 ABI dependency). Use the local Node development headers.
NODE_HEADERS="${SOUNDFACE_NODE_HEADERS:-$(node -p 'require("node:path").resolve(process.execPath, "../../include/node")')}"
if [ ! -f "$NODE_HEADERS/node_api.h" ]; then
  echo 'Node-API headers not found. Set SOUNDFACE_NODE_HEADERS to a Node include/node directory.' >&2
  exit 1
fi
xcrun clang++ -O2 -fobjc-arc -std=c++17 -DNAPI_VERSION=8 -mmacosx-version-min=13.0 \
  -I "$NODE_HEADERS" -bundle -undefined dynamic_lookup "$ROOT/native/camera/Activation.mm" \
  -framework Foundation -framework SystemExtensions -framework Security -o "$ROOT/build/soundface-camera.node"
codesign --force --sign - "$ROOT/build/soundface-camera.node"
