#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build"
xcrun clang -g -fsanitize=address,undefined "$ROOT/tests/ring.c" "$ROOT/native/audio/Ring.c" -o "$ROOT/build/test-ring"
"$ROOT/build/test-ring"
