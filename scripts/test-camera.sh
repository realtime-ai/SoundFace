#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build"
xcrun swiftc -g -sanitize=address "$ROOT/native/camera/FrameStore.swift" "$ROOT/tests/FrameStoreTests.swift" -framework CoreVideo -o "$ROOT/build/test-camera"
"$ROOT/build/test-camera"
xcrun swiftc -g -sanitize=address "$ROOT/native/video/GeneratedFrame.swift" "$ROOT/tests/GeneratedFrameTests.swift" -framework CoreImage -framework ImageIO -framework CoreVideo -o "$ROOT/build/test-generated-frame"
"$ROOT/build/test-generated-frame" "$ROOT/build/generated-frame-test.jpg"
