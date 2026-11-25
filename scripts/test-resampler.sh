#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build"
xcrun clang -g -fsanitize=address,undefined -Wno-unused-parameter \
  "$ROOT/tests/resampler.c" "$ROOT/native/audio/Resampler.c" "$ROOT/native/audio/Ring.c" \
  -framework AudioToolbox -framework CoreAudio -o "$ROOT/build/test-resampler"
"$ROOT/build/test-resampler"
