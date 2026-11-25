#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build"
xcrun clang -O2 -mmacosx-version-min=13.0 -c "$ROOT/native/audio/Ring.c" -o "$ROOT/build/Ring.o"
xcrun clang -O2 -Wall -Wextra -Wno-unused-parameter -mmacosx-version-min=13.0 -c "$ROOT/native/audio/Resampler.c" -o "$ROOT/build/Resampler.o"
xcrun clang -O2 -Wall -Wextra -Wno-unused-parameter -mmacosx-version-min=13.0 -c "$ROOT/native/audio/AudioIO.c" -o "$ROOT/build/AudioIO.o"
xcrun swiftc -O -target "$(uname -m)-apple-macosx13.0" -import-objc-header "$ROOT/native/audio/Bridge.h" \
  "$ROOT/native/audio/AudioBridge.swift" "$ROOT/build/Ring.o" "$ROOT/build/AudioIO.o" "$ROOT/build/Resampler.o" \
  -framework AVFoundation -framework CoreAudio -framework AudioToolbox \
  -o "$ROOT/build/soundface-audio"
codesign --force --sign "${SOUNDFACE_SIGN_IDENTITY:--}" "$ROOT/build/soundface-audio"
