#!/usr/bin/env bash
# scripts/install-monthly-sync.sh — 安装「每月 1 号自动同步上游」的 launchd 任务 (macOS)
#
#   scripts/install-monthly-sync.sh              安装（并立刻做一次 --check 试跑）
#   scripts/install-monthly-sync.sh --hour 9     指定几点跑（默认 12 点）
#   scripts/install-monthly-sync.sh --no-test    不要试跑
#
# 卸载: scripts/uninstall-monthly-sync.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.${USER:-user}.moyu-youtube-tabs.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HOUR=12
MIN=30
TEST=1

while [ $# -gt 0 ]; do
  case "$1" in
    --hour) HOUR="$2"; shift 2 ;;
    --minute) MIN="$2"; shift 2 ;;
    --no-test) TEST=0; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "这只在 macOS 上有用（其他系统请用 cron 调 scripts/sync-upstream.sh）。" >&2
  exit 2
fi

NODE_DIR="$(dirname "$(command -v node || echo /opt/homebrew/bin/node)")"
mkdir -p "$ROOT/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$ROOT/scripts/sync-upstream.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT</string>
    <!-- 每个月的 1 号 $HOUR:$(printf '%02d' "$MIN") 跑一次；Mac 睡眠时会等唤醒后补跑 -->
    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Day</key><integer>1</integer>
            <key>Hour</key><integer>$HOUR</integer>
            <key>Minute</key><integer>$MIN</integer>
        </dict>
    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$ROOT/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT/logs/launchd.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF

echo "已写入 $PLIST"
plutil -lint "$PLIST" >/dev/null || { echo "plist 格式有问题，放弃" >&2; exit 1; }

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
if launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then
  echo "已加载任务 (bootstrap)"
else
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST" && echo "已加载任务 (load -w)"
fi

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  echo "✔ launchd 任务已注册: $LABEL"
  launchctl print "gui/$UID/$LABEL" | grep -E '^[[:space:]]*(state|program|runs) ' | sed 's/^/    /'
  echo "    下次运行时间由 StartCalendarInterval 决定: 每月 1 号 $HOUR:$(printf '%02d' "$MIN")"
else
  echo "✖ 任务没注册上，请把上面的报错发我看一下" >&2
  exit 1
fi

# 立刻手动跑一次（--check 模式，只报告不修改），确认脚本本身能跑通
if [ "$TEST" -eq 1 ]; then
  echo
  echo "=== 试跑一次 (--check，不会改动任何文件) ==="
  bash "$ROOT/scripts/sync-upstream.sh" --check
fi

echo
echo "查看日志: tail -f $ROOT/logs/sync.log"
echo "手动同步: $ROOT/scripts/sync-upstream.sh"
echo "卸载任务: $ROOT/scripts/uninstall-monthly-sync.sh"
