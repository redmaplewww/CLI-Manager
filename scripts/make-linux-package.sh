#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
NAME="aura-butler-linux"

rm -rf "$OUT/$NAME"
mkdir -p "$OUT/$NAME"

rsync -a \
  --exclude node_modules \
  --exclude data \
  --exclude .env \
  --exclude dist \
  --exclude butler.config.json \
  --exclude '*.docx' \
  --exclude '*.cmd' \
  "$ROOT/" "$OUT/$NAME/"

cd "$OUT"
tar -czf "$NAME.tar.gz" "$NAME"
echo "$OUT/$NAME.tar.gz"
