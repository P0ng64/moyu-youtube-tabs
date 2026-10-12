#!/usr/bin/env bash
# scripts/sync-upstream.sh — 检查上游（Maasea/墨鱼引用的 youtube.response.js）有没有更新，
#                            有更新就重新打补丁、重新生成 dist/、提交；打不上补丁就回滚并告警。
#
#   scripts/sync-upstream.sh            自动同步（有变化才动）
#   scripts/sync-upstream.sh --check    只看有没有更新，不改任何东西
#   scripts/sync-upstream.sh --force    即使上游没变化也重新生成 dist/
#   scripts/sync-upstream.sh --no-push  本地提交但不推送
#
# 退出码: 0 正常（含“无更新”） / 1 需要人工介入（上游结构变了）/ 2 网络或环境问题
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE=sync
NO_PUSH=0
for a in "$@"; do
  case "$a" in
    --check)   MODE=check ;;
    --force)   MODE=force ;;
    --no-push) NO_PUSH=1 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

mkdir -p logs
LOG="$ROOT/logs/sync.log"
NEEDS="$ROOT/SYNC_NEEDS_REVIEW.md"

log() { local line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"; echo "$line" | tee -a "$LOG"; }

notify() {   # macOS 通知（尽力而为，失败不影响流程）
  command -v osascript >/dev/null 2>&1 || return 0
  osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}

command -v node >/dev/null 2>&1 || { log "找不到 node，无法继续"; exit 2; }
command -v curl >/dev/null 2>&1 || { log "找不到 curl，无法继续"; exit 2; }

UP_URL="$(node -e 'process.stdout.write(require("./upstream/source.json").url)' 2>/dev/null)"
[ -n "$UP_URL" ] || { log "读不到 upstream/source.json 里的 url"; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/moyu-yt-tabs.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
NEW="$TMP/upstream.new.js"

log "== 同步检查开始 (mode=$MODE) 上游: $UP_URL"
if ! curl -fsSL --retry 3 --retry-delay 5 --max-time 90 -o "$NEW" "$UP_URL"; then
  log "下载上游失败（网络问题？），本次跳过"; exit 2
fi

# --- 基本体检，避免把 HTML 报错页/截断文件当成脚本 ---
SIZE=$(wc -c < "$NEW" | tr -d ' ')
if [ "$SIZE" -lt 50000 ] || head -c 200 "$NEW" | grep -qi '<!doctype\|<html'; then
  log "下载到的东西不像脚本 (${SIZE} 字节)，放弃"; exit 2
fi
for kw in 'rendererItems' 'toBinary'; do
  grep -q "$kw" "$NEW" || { log "上游文件缺少关键字 $kw，放弃"; exit 2; }
done

NEW_SHA=$(shasum -a 256 "$NEW" | awk '{print $1}')
CUR_SHA=$(shasum -a 256 upstream/youtube.response.js | awk '{print $1}')
OLD_BUILD=$(head -1 upstream/youtube.response.js | tr -d '\r')
NEW_BUILD=$(head -1 "$NEW" | tr -d '\r')

if [ "$NEW_SHA" = "$CUR_SHA" ]; then
  log "上游没有更新 (sha256 ${NEW_SHA%%????????????????}…, $NEW_BUILD)"
  if [ "$MODE" = force ]; then
    log "--force: 按现有上游重新生成 dist/"
    node build/build.js >> "$LOG" 2>&1 || { log "重新生成失败"; exit 1; }
    log "重新生成完成"
  fi
  exit 0
fi

log "上游有更新: ${OLD_BUILD:-无}  ->  $NEW_BUILD  (sha256 ${CUR_SHA:0:16}… -> ${NEW_SHA:0:16}…)"
if [ "$MODE" = check ]; then
  log "--check: 只报告，不改动"
  exit 0
fi

# --- 应用新上游 ---
cp upstream/youtube.response.js "$TMP/upstream.prev.js"
cp "$NEW" upstream/youtube.response.js

fail() {   # $1 = 原因
  log "✖ $1 —— 回滚到上一个能用的状态"
  cp "$TMP/upstream.prev.js" upstream/youtube.response.js
  git checkout -- dist 2>/dev/null || true
  node build/build.js >> "$LOG" 2>&1 || true
  cat > "$NEEDS" <<EOF
# 需要人工处理：上游脚本结构变了

时间: $(date '+%Y-%m-%d %H:%M:%S')
上游: $UP_URL
变化: ${OLD_BUILD:-?} -> ${NEW_BUILD:-?}
原因: $1

已自动回滚到上一个能用的上游版本，手机上的脚本不受影响。

## 怎么办

1. 拿到新版上游并和本地比一比：
   \`\`\`
   cd $ROOT
   curl -fsSL "$UP_URL" -o /tmp/youtube.response.new.js
   grep -o 'function [a-zA-Z_$]*([^)]*){let t=\["SPunlimited"[^}]*}' /tmp/youtube.response.new.js | head -3
   grep -o 'rendererItems[^;]\{0,200\}' /tmp/youtube.response.new.js | head -5
   \`\`\`
   重点看 rendererItems 的过滤逻辑（搜 SPunlimited / FEshorts / rendererItems）。
2. 如果只是特征串换了名字，改 build/build.js 顶部的 MARKER / NEEDED 常量即可。
3. 如果上游把底部标签逻辑整个改掉了，改 build/build.js 里的 replacement() 让它对准新的写法。
4. 改完跑：
   \`\`\`
   scripts/sync-upstream.sh --force   # 重新应用并生成
   node tests/test-bottom-tabs.js     # 端到端验证
   \`\`\`
5. 一切正常后删掉本文件再提交。
EOF
  notify "YouTube 去广告脚本同步失败" "上游结构变了，已回滚，见 SYNC_NEEDS_REVIEW.md"
  exit 1
}

log "重新打补丁 + 生成 dist/ ..."
if ! node build/build.js >> "$LOG" 2>&1; then
  tail -5 "$LOG" | sed 's/^/    /'
  fail "补丁打不上（找不到底部标签过滤函数）"
fi

log "跑端到端测试 ..."
if ! node tests/test-bottom-tabs.js >> "$LOG" 2>&1; then
  sed -n '$p' "$LOG" | sed 's/^/    /'
  fail "测试没通过，定制层的行为与预期不符"
fi

# --- 记录新版本信息 ---
node - "$NEW_SHA" "$NEW_BUILD" "$CUR_SHA" <<'NODE' >> "$LOG" 2>&1
const fs = require('fs');
const p = 'upstream/source.json';
const [sha, build, prev] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.upstream_build_line = build;
j.sha256 = sha;
j.bytes = fs.statSync('upstream/youtube.response.js').size;
j.downloaded_at = new Date().toISOString();
j.previous_sha256 = prev;
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
console.log('source.json 已更新:', sha.slice(0, 16) + '…');
NODE

rm -f "$NEEDS"

# --- 提交 ---
if [ -n "$(git status --porcelain)" ]; then
  GIT_ID=()
  if [ -z "$(git config user.email || true)" ]; then
    GIT_ID=(-c user.name="moyu-yt-tabs sync" -c user.email="moyu-yt-tabs@localhost")
    log "提示: 未配置 git user.email，本次提交使用临时身份"
  fi
  git add -A
  if git ${GIT_ID[@]+"${GIT_ID[@]}"} commit -q -m "chore(upstream): 同步上游脚本 ${NEW_BUILD#// }" >> "$LOG" 2>&1; then
    log "已提交: $(git log -1 --pretty=%s)"
  else
    log "提交失败（见日志），文件已更新但没进版本历史"
  fi

  if [ "$NO_PUSH" -eq 0 ] && git remote get-url origin >/dev/null 2>&1; then
    if git push >> "$LOG" 2>&1; then
      log "已推送到远端 —— 客户端「外部资源 → 全部更新」后即可生效"
    else
      log "推送失败（凭据/网络？），本地已提交，等下次或手动 git push"
    fi
  fi
else
  log "没有文件变化"
fi

log "== 同步完成: ${NEW_BUILD:-?}"
notify "YouTube 去广告脚本已同步上游" "${NEW_BUILD:-新版本}，重装/更新外部资源后生效"
exit 0
