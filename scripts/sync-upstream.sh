#!/usr/bin/env bash
# scripts/sync-upstream.sh — 同步两个上游；有变化就重新生成 dist/、跑测试、提交（有 remote 就 push）：
#     ① Maasea 的 youtube.response.js —— 墨鱼 YoutubeAds.conf 引用的那个去广告脚本
#     ② 墨鱼 ddgksf2013/Rewrite 的 YoutubeAds.conf —— 重写规则本体
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
command -v shasum >/dev/null 2>&1 || { log "找不到 shasum，无法继续"; exit 2; }

# ---------- 上游源定义 ----------
SRC_LOCAL=(upstream/youtube.response.js upstream/YoutubeAds.conf)
SRC_SOURCE=(upstream/source.json        upstream/source.rewrite.json)
SRC_LABEL=("去广告脚本"                 "墨鱼重写 conf")

url_of() { node -e "process.stdout.write(require('./$1').url)" 2>/dev/null; }
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }
short()  { printf '%.16s' "$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/moyu-yt-tabs.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/dist.prev" && cp -a dist/. "$TMP/dist.prev/"                  # 回滚用: dist 快照
for f in "${SRC_LOCAL[@]}"; do cp "$f" "$TMP/$(basename "$f").prev"; done   # 回滚用: 上游快照

log "== 同步检查开始 (mode=$MODE)"

NET_FAIL=0
declare -a CHANGED
i=0
for f in "${SRC_LOCAL[@]}"; do
  CHANGED[$i]=0
  url="$(url_of "${SRC_SOURCE[$i]}")"
  if [ -z "$url" ]; then log "✖ ${SRC_LABEL[$i]}: 读不到 ${SRC_SOURCE[$i]} 里的 url"; NET_FAIL=1; i=$((i+1)); continue; fi
  out="$TMP/new.$i"
  if ! curl -fsSL --retry 3 --retry-delay 5 --max-time 90 -o "$out" "$url"; then
    log "✖ ${SRC_LABEL[$i]}: 下载失败（网络？）$url"; NET_FAIL=1; i=$((i+1)); continue
  fi
  size=$(wc -c < "$out" | tr -d ' ')
  if head -c 200 "$out" | grep -qi '<!doctype\|<html'; then
    log "✖ ${SRC_LABEL[$i]}: 下载到的是网页，不是文件"; NET_FAIL=1; i=$((i+1)); continue
  fi
  # 体检：别把截断文件/报错页当成上游
  if [ "$i" -eq 0 ]; then
    if [ "$size" -lt 50000 ] || ! grep -q 'rendererItems' "$out" || ! grep -q 'toBinary' "$out"; then
      log "✖ ${SRC_LABEL[$i]}: 内容不像脚本 (${size} 字节)"; NET_FAIL=1; i=$((i+1)); continue
    fi
  else
    if [ "$size" -lt 200 ] || ! grep -q ' url ' "$out" || ! grep -q 'script-response-body' "$out"; then
      log "✖ ${SRC_LABEL[$i]}: 内容不像重写 conf (${size} 字节)"; NET_FAIL=1; i=$((i+1)); continue
    fi
  fi

  news=$(sha_of "$out"); curs=$(sha_of "$f")
  if [ "$news" != "$curs" ]; then
    CHANGED[$i]=1
    log "· ${SRC_LABEL[$i]}: 有更新  $(short "$curs")… -> $(short "$news")…  $(head -1 "$out" | tr -d '\r')"
  else
    log "· ${SRC_LABEL[$i]}: 未变化  $(short "$curs")…"
  fi
  i=$((i+1))
done

ANY=0
for k in "${!SRC_LOCAL[@]}"; do [ "${CHANGED[$k]}" = 1 ] && ANY=1; done

if [ "$ANY" -eq 0 ]; then
  if [ "$NET_FAIL" -eq 1 ]; then log "有源没下载成功，且没有确认到更新 —— 本次不动"; exit 2; fi
  log "上游都没有更新"
  if [ "$MODE" = force ]; then
    log "--force: 按现有上游重新生成 dist/"
    node build/build.js >> "$LOG" 2>&1 || { log "✖ 重新生成失败"; exit 1; }
    log "重新生成完成"
  fi
  exit 0
fi

if [ "$MODE" = check ]; then log "--check: 只报告，不改动"; exit 0; fi

# ---------- 应用新上游 ----------
MSG_PARTS=""
for k in "${!SRC_LOCAL[@]}"; do
  if [ "${CHANGED[$k]}" = 1 ]; then
    cp "$TMP/new.$k" "${SRC_LOCAL[$k]}"
    if [ -z "$MSG_PARTS" ]; then MSG_PARTS="${SRC_LABEL[$k]}"; else MSG_PARTS="$MSG_PARTS 与 ${SRC_LABEL[$k]}"; fi
  fi
done
log "开始重新生成（更新了: ${MSG_PARTS}）"

fail() {   # $1 = 原因
  log "✖ $1 —— 回滚到上一个能用的状态"
  for f in "${SRC_LOCAL[@]}"; do cp "$TMP/$(basename "$f").prev" "$f"; done
  rm -rf dist && mkdir -p dist && cp -a "$TMP/dist.prev/." dist/   # 精确还原，避免留下半成品
  log "已回滚: 上游文件与整个 dist/ 都恢复成运行前的样子（手机上的脚本不受影响）"
  cat > "$NEEDS" <<EOF
# 需要人工处理：上游变了，自动打补丁/生成失败

时间: $(date '+%Y-%m-%d %H:%M:%S')
原因: $1
更新的源: $MSG_PARTS

已自动回滚到运行前的状态，dist/ 字节级一致，手机上的脚本不受影响。

## 怎么办

1. 看清楚上游改了什么:
   \`\`\`
   cd $ROOT
   # 去广告脚本: 找底部标签过滤逻辑
   grep -o 'SPunlimited[^;]\{0,80\}' upstream/youtube.response.js | head -3
   grep -o 'rendererItems[^;]\{0,120\}' upstream/youtube.response.js | head -5
   # 墨鱼重写 conf: 找 script 行和 hostname
   grep -n 'script-\|hostname' upstream/YoutubeAds.conf
   \`\`\`
2. 常见情况与对策:
   - 脚本里底部标签逻辑换了写法 → 改 build/build.js 里的 MARKER / NEEDED 判据，或 replacement() 对准新写法;
   - conf 里那条 script 行写法变了（换成了 script-request-body、或换了脚本文件名）→ 改 build/build.js 里的 SCRIPT_BASENAME 或那段正则;
   - 上游新增了别的脚本行 → build/build.js 只重定向「指向 youtube.response.js」的行，确认这是你要的。
3. 改完跑:
   \`\`\`
   scripts/sync-upstream.sh --force    # 重新应用并生成
   node tests/test-scripts.js          # shell 脚本自检（含 bash 3.2 陷阱扫描）
   node tests/test-bottom-tabs.js      # 底部标签定制: 端到端测试
   node tests/test-conf.js             # QX 订阅 conf 的测试
   \`\`\`
4. 一切正常后删掉本文件再提交。
EOF
  notify "YouTube 去广告订阅同步失败" "${1}；已回滚，见 SYNC_NEEDS_REVIEW.md"
  exit 1
}

node build/build.js >> "$LOG" 2>&1 || { tail -6 "$LOG" | sed 's/^/    /'; fail "生成失败（补丁或 conf 打不上）"; }

log "跑测试 ..."
node tests/test-scripts.js      >> "$LOG" 2>&1 || { grep -E '^[0-9]+ 通过|^✖' "$LOG" | tail -3 | sed 's/^/    /'; fail "shell 脚本自检没通过"; }
node tests/test-bottom-tabs.js >> "$LOG" 2>&1 || { grep -E '^[0-9]+ 通过' "$LOG" | tail -1 | sed 's/^/    /'; fail "底部标签定制的测试没通过"; }
node tests/test-conf.js        >> "$LOG" 2>&1 || { grep -E '^[0-9]+ 通过' "$LOG" | tail -1 | sed 's/^/    /'; fail "QX 订阅 conf 的测试没通过"; }

# ---------- 记录新版本信息 ----------
for k in "${!SRC_LOCAL[@]}"; do
  [ "${CHANGED[$k]}" = 1 ] || continue
  S=$(sha_of "${SRC_LOCAL[$k]}"); B=$(wc -c < "${SRC_LOCAL[$k]}" | tr -d ' '); L=$(head -1 "${SRC_LOCAL[$k]}" | tr -d '\r')
  node - "${SRC_SOURCE[$k]}" "$S" "$B" "$L" <<'NODE' >> "$LOG" 2>&1
const fs = require('fs');
const [p, sha, bytes, buildLine] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
if (j.sha256) j.previous_sha256 = j.sha256;
j.sha256 = sha;
j.bytes = Number(bytes);
j.downloaded_at = new Date().toISOString();
if (buildLine && /^(?:\/\/|#)/.test(buildLine)) j.upstream_build_line = buildLine;
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
console.log(`${p} 已更新: ${sha.slice(0, 16)}…`);
NODE
done

rm -f "$NEEDS"

# ---------- 提交 ----------
if [ -n "$(git status --porcelain)" ]; then
  GIT_ID=()
  if [ -z "$(git config user.email || true)" ]; then
    GIT_ID=(-c user.name="moyu-yt-tabs sync" -c user.email="moyu-yt-tabs@localhost")
    log "提示: 未配置 git user.email，本次提交使用临时身份"
  fi
  git add -A
  if git ${GIT_ID[@]+"${GIT_ID[@]}"} commit -q -m "chore(upstream): 同步 $MSG_PARTS" >> "$LOG" 2>&1; then
    log "已提交: $(git log -1 --pretty=%s)"
  else
    log "提交失败（见日志），文件已更新但没进版本历史"
  fi

  if [ "$NO_PUSH" -eq 0 ] && git remote get-url origin >/dev/null 2>&1; then
    if git push >> "$LOG" 2>&1; then
      log "已推送到远端 —— 客户端「外部资源 → 全部更新」后生效"
    else
      log "推送失败（凭据/网络？），本地已提交，等下次或手动 git push"
    fi
  fi
else
  log "没有文件变化"
fi

log "== 同步完成"
notify "YouTube 去广告订阅已同步上游" "重新「全部更新」外部资源后生效"
exit 0
