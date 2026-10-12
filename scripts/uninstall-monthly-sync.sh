#!/usr/bin/env bash
# scripts/uninstall-monthly-sync.sh — 卸载每月自动同步上游的 launchd 任务
set -uo pipefail

LABEL="com.${USER:-user}.moyu-youtube-tabs.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -f "$PLIST" ]; then
  echo "没找到 $PLIST，可能本来就没装。"
  exit 0
fi

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  echo "✖ 任务似乎还在，手动检查: launchctl print gui/$UID/$LABEL" >&2
  exit 1
fi
echo "✔ 已卸载 $LABEL（脚本和 dist/ 都还在，只是不再自动同步）"
