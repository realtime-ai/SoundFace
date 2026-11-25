#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/dist"
# Explicit inputs exclude keys, caches, build output and personal files.
COPYFILE_DISABLE=1 tar -czf "$ROOT/dist/SoundFace-dev-source.tar.gz" -C "$ROOT" \
  app native scripts tests docs assets/default-character.jpg assets/README.md assets/icons \
  package.json package-lock.json README.md .gitignore
