#!/usr/bin/env bash
# scripts/customize.sh — 交互式定制 YouTube 底部标签栏，改完自动重新生成 dist/。
#
#   scripts/customize.sh              交互式定制
#   scripts/customize.sh --show       只看当前配置
#   scripts/customize.sh --rebuild    不改配置，只重新生成 dist/
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "找不到 node。请先安装 Node.js (brew install node)，或把 node 加进 PATH。" >&2
  exit 1
fi

cd "$ROOT"
exec "$NODE" "$ROOT/scripts/customize.js" "$@"
