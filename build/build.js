#!/usr/bin/env node
/**
 * build/build.js — 把「底部标签栏定制层」注入上游 YouTube 去广告脚本。
 *
 * 输入:  upstream/youtube.response.js   (上游原始脚本, 只读, 永不修改)
 *        config/bottom-tabs.json       (用户定制配置, 由 scripts/customize.js 生成)
 *        build/tabs.catalog.json       (已知底部标签 browseId 目录)
 * 输出:  dist/youtube.response.js       (可直接被 QuantumultX/Surge/Loon 引用)
 *        dist/manifest.json            (构建元信息)
 *        dist/qx-rewrite.txt           (可直接粘贴的 QuantumultX 重写行)
 *
 * 上游结构一旦变化导致找不到「底部标签过滤函数」，本脚本会报错退出（绝不产出半成品）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const P = {
  upstream: path.join(ROOT, 'upstream', 'youtube.response.js'),
  source: path.join(ROOT, 'upstream', 'source.json'),
  confUpstream: path.join(ROOT, 'upstream', 'YoutubeAds.conf'),
  confSource: path.join(ROOT, 'upstream', 'source.rewrite.json'),
  config: path.join(ROOT, 'config', 'bottom-tabs.json'),
  catalog: path.join(ROOT, 'build', 'tabs.catalog.json'),
  dist: path.join(ROOT, 'dist', 'youtube.response.js'),
  distConf: path.join(ROOT, 'dist', 'YoutubeAds.custom.conf'),
  manifest: path.join(ROOT, 'dist', 'manifest.json'),
  qxline: path.join(ROOT, 'dist', 'qx-rewrite.txt'),
};

const MARKER = 'SPunlimited';                                              // 上游底部标签过滤函数的特征串（它的写死隐藏列表里必有这个 ID）
const NEEDED = ['rendererItems', 'iconRender', 'labelRender', 'browseId'];  // 该函数必须含有的特征

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };
const die = (msg) => { console.error('✖ ' + msg); process.exit(1); };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const read = (p) => fs.readFileSync(p, 'utf8');
const readJSON = (p) => JSON.parse(read(p));
const readJSONIfExists = (p, fb) => { try { return readJSON(p); } catch (e) { return fb; } };

/* ---------- 1. 在上游脚本里定位「底部标签过滤函数」 ---------- *
 * 不依赖压缩后的函数名（esbuild 会改名），只依赖语义特征：
 *   - 函数体里出现 ["SPunlimited"]（上游写死的隐藏列表）
 *   - 同一个函数里出现 rendererItems / iconRender / labelRender / browseId
 * 找到后用大括号配对（跳过字符串/注释）取出整个函数的文本区间。
 */

function skipStringOrComment(text, i) {
  const c = text[i];
  if (c === '"' || c === "'" || c === '`') {
    const quote = c;
    i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === quote) { i++; break; }
      i++;
    }
    return i;
  }
  if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; return i; }
  if (c === '/' && text[i + 1] === '*') {
    i += 2;
    while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
    return i + 2;
  }
  return -1;
}

function matchBraces(text, braceIdx) {          // braceIdx 指向 '{'，返回配对的 '}' 的索引
  let depth = 0;
  for (let i = braceIdx; i < text.length; i++) {
    const skipped = skipStringOrComment(text, i);
    if (skipped >= 0) { i = skipped - 1; continue; }
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findEnclosingFunction(text, idx) {
  const re = /(?:^|[^\w$.])function\s+([\w$]+)\s*\(/g;
  const head = text.slice(0, idx);
  let best = null, m;
  while ((m = re.exec(head)) !== null) best = m;
  if (!best) return null;

  let i = best.index + best[0].length - 1;      // 指向 '('
  let depth = 0;
  for (; i < text.length; i++) {
    const skipped = skipStringOrComment(text, i);
    if (skipped >= 0) { i = skipped - 1; continue; }
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;

  return {
    name: best[1],
    params: text.slice(best.index + best[0].length, i - 1),
    start: best.index + (best[0].startsWith('function') ? 0 : 1),
    braceIdx: i,
  };
}

function locateTabFunction(text) {
  /* 上游可能: 改函数名、往写死的列表里加/删 ID、调整顺序 —— 这些都不该让我们失手。
     所以遍历所有出现特征串的地方，取「外层函数里确实在过滤 rendererItems」的那一个。 */
  const found = [];
  let at = -1;
  while ((at = text.indexOf(MARKER, at + 1)) >= 0) {
    const fn = findEnclosingFunction(text, at);
    if (!fn) continue;
    const end = matchBraces(text, fn.braceIdx);
    if (end < 0) continue;
    const src = text.slice(fn.start, end + 1);
    if (!NEEDED.every((n) => src.includes(n))) continue;
    const walkerMatch = /([\w$]+)\(\s*[\w$]+\s*,\s*"rendererItems"/.exec(src);
    if (!walkerMatch) continue;
    if (src.length > 6000) continue;
    const first = fn.params.split(',')[0].trim();
    if (!/^[\w$]+$/.test(first)) continue;
    if (!/\{\s*params\s*:\s*[\w$]+\s*\}/.test(fn.params)) continue;
    found.push({ ...fn, end, src, walker: walkerMatch[1], data: first });
  }

  if (found.length === 0) {
    const seen = text.indexOf(MARKER) >= 0;
    die(`没能在上游脚本里找到「过滤底部标签的那个函数」。\n` +
        `  判据: 函数里同时出现 ${MARKER}、${NEEDED.join(' / ')}，并且在遍历 "rendererItems"。\n` +
        (seen ? '  特征串还在，但所属函数的形态变了 —— 上游可能重构了这部分逻辑。\n'
              : `  连特征串 ${MARKER} 都找不到 —— 上游可能整段重写了。\n`) +
        '  请人工检查 upstream/youtube.response.js，再更新 build/build.js 的补丁。');
  }
  if (found.length > 1) {
    const list = found.map((f) => `${f.name}(${f.params}) @${f.start} [${f.src.length}字符]`).join('\n    ');
    die(`有 ${found.length} 个函数都符合判据，无法确定该改哪一个（怕改错，故拒绝）:\n    ${list}\n` +
        '  请在 build/build.js 里加一条更具体的判据。');
  }
  return found[0];
}

/* ---------- 2. 生成注入内容 ---------- */

function effectiveHide(cfg) {
  const hide = (cfg.hide || []).slice();
  if (!cfg.disableLegacy) hide.push('SPunlimited', 'FEuploads', 'FEmusic_immersive');  // 上游 ai() 默认值
  return [...new Set(hide)];
}

function header(cfg, catalog, ts, upstreamBuildLine) {
  const tabs = {
    hide: cfg.hide || [],
    keep: cfg.keep || [],
    keepUnknown: cfg.keepUnknown !== false,
    disableLegacy: cfg.disableLegacy !== false,
    debug: !!cfg.debug,
  };
  const cat = {};
  for (const [id, info] of Object.entries(catalog.items || {})) cat[id] = { name: info.name, app: info.app };
  for (const [id, name] of Object.entries(cfg.catalogExtras || {})) cat[id] = { name, app: 'custom' };

  return `/* ============================================================================
 * 定制层 · YouTube 底部标签栏 (Bottom Tab)                       【勿手改此段】
 * 配置源 : config/bottom-tabs.json
 * 生成器 : build/build.js    生成时间: ${ts}
 * 上游   : ${upstreamBuildLine}
 * 用 scripts/customize.sh 交互式改配置，改完会重新生成整个文件。
 * ========================================================================== */
globalThis.__YT_BOTTOM_TABS__ = ${JSON.stringify(tabs)};
globalThis.__YT_TAB_CATALOG__ = ${JSON.stringify(cat)};
(function () {
    var C = globalThis.__YT_BOTTOM_TABS__ || {};
    var CAT = globalThis.__YT_TAB_CATALOG__ || {};
    var _logged = Object.create(null);
    function _nm(id) { var e = CAT[id]; return e ? e.name : ''; }
    globalThis.__ytBottomTabFilter = function (params) {
        var hide = (C.hide || []).slice(0);
        var keep = C.keep || [];
        if (!C.disableLegacy) {                        // 上游旧开关仍然生效
            hide.push('SPunlimited');
            if (params && params.blockUpload) hide.push('FEuploads');
            if (params && params.blockImmersive) hide.push('FEmusic_immersive');
            if (params && params.blockShorts) hide.push('FEshorts');
        }
        var keepMode = keep.length > 0;
        return function (id) {
            if (!id) return false;
            var known = Object.prototype.hasOwnProperty.call(CAT, id);
            if (C.debug && !_logged[id]) {
                _logged[id] = 1;
                console.log('[YT-Tabs] 底部标签: ' + id + (known ? ' (' + _nm(id) + ')' : ' (未知, 未在目录中)'));
            }
            if (keepMode) {                            // 白名单模式
                if (keep.indexOf(id) >= 0) return false;
                if (!known) return !C.keepUnknown;     // 目录外的未知标签：按 keepUnknown 决定
                return true;                           // 目录内且不在白名单 -> 移除
            }
            var drop = hide.indexOf(id) >= 0;          // 黑名单模式
            if (drop && C.debug) console.log('[YT-Tabs] 移除底部标签: ' + id + (known ? ' (' + _nm(id) + ')' : ''));
            return drop;
        };
    };
})();

`;
}

function replacement(fn) {
  const pvMatch = /\{\s*params\s*:\s*([\w$]+)\s*\}/.exec(fn.params);
  if (!pvMatch) die(`无法从参数列表 "${fn.params}" 中取出 params 变量名。`);
  const pv = pvMatch[1], L = fn.data, W = fn.walker;
  const hit = '_ytHit', tabs = '_ytTabs', nd = '_ytNode', ix = '_ytI', id = '_ytId';
  return `function ${fn.name}(${fn.params}){` +
    `let ${tabs}=globalThis.__ytBottomTabFilter(${pv}),${hit}=!1;` +
    `return ${W}(${L},"rendererItems",${nd}=>{` +
    `for(let ${ix}=${nd}.rendererItems.length-1;${ix}>=0;${ix}--){` +
    `let ${id}=${nd}.rendererItems[${ix}]?.iconRender?.browseId??${nd}.rendererItems[${ix}]?.labelRender?.browseId;` +
    `${id}&&${tabs}(${id})&&(${nd}.rendererItems.splice(${ix},1),${hit}=!0)` +
    `}}),{bodyChanged:${hit},stateChanged:!1}}`;
}

/* ---------- 2.5 生成 QuantumultX 重写订阅 conf ---------- *
 * 直接把墨鱼那份 YoutubeAds.conf 拿过来，只把「指向上游脚本的 URL」换成我们定制版的地址，
 * 其余（注释、hostname、各条 reject/302 规则）逐字保留 —— 这样它既能当 QX 订阅资源用，
 * 也保证去广告本身的行为和墨鱼那份完全一致。
 */
const SCRIPT_BASENAME = 'youtube.response.js';

function buildConf(ts, scriptUrl, confSource) {
  let upstreamConf;
  try {
    upstreamConf = read(P.confUpstream);
  } catch (e) {
    log('· 跳过 conf 生成：找不到 upstream/YoutubeAds.conf（跑一次 scripts/sync-upstream.sh 会补上）');
    return null;
  }

  // 规则行 = 非注释、非空、且含 " url " 的行；hostname = … 这类指令行不算规则
  const lineIsRule = (l) => l.trim() && !/^\s*#/.test(l) && /\surl\s+/.test(l);
  let repointed = 0;
  const outLines = upstreamConf.split('\n').map((line) => {
    if (!lineIsRule(line)) return line;
    return line.replace(/(\burl\s+script-(?:response|request)-(?:body|header)\s+)(\S+)/g, (m, head, u) => {
      if (!u.includes(SCRIPT_BASENAME)) return m;          // 只重定向「上游那个脚本」的行，别的脚本不碰
      repointed++;
      return head + scriptUrl;
    });
  });
  if (repointed === 0) {
    die(`上游 YoutubeAds.conf 里找不到指向 ${SCRIPT_BASENAME} 的 script 行 —— 上游结构变了，需要人工检查。`);
  }

  const rules = outLines.filter(lineIsRule);
  rules.forEach((l) => {
    if (/Maasea\/sgmodule/.test(l)) die(`生成的 conf 里还有上游脚本地址没换掉:\n  ${l}`);
    if (!/\surl\s+(reject|reject-\d+|302|307|script-response-body|script-request-body|script-response-header|script-request-header)\b/.test(l)) {
      die(`生成的 conf 里有条规则看不懂（可能上游换了写法）:\n  ${l}`);
    }
    const pattern = l.split(/\s+url\s+/)[0];
    try { new RegExp(pattern); } catch (err) { die(`规则里的正则写错了，客户端会直接报错:\n  ${pattern}\n  ${err.message}`); }
  });

  const src = confSource || {};
  const head = [
    '########################################',
    '# 本文件由 moyu-youtube-tabs 自动生成，请勿手改（改配置请跑 scripts/customize.sh）',
    `# 生成时间：  ${ts}`,
    `# 定制版脚本：${scriptUrl}`,
    `# 上游重写：  ${src.url || '?'}`,
    `# 上游版本：  sha256 ${(src.sha256 || '?').slice(0, 16)}…  共 ${rules.length} 条规则`,
    '# 定制内容：  YouTube 底部标签栏 (Bottom Tab) 可定制，配置见 config/bottom-tabs.json',
    '# 用法：      在 QuantumultX「重写 → 添加订阅」填本文件的 raw 地址；',
    '#             或写进配置的 [rewrite_remote]：本文件地址, tag=moyu-youtube-tabs, enabled=true',
    '#             需要开启 MITM 并信任证书（hostname 行已包含在本文件里）。',
    '# 注意：      脚本改动后要在 QX「外部资源 → 全部更新」并彻底重启 YouTube。',
    '########################################',
    '',
  ].join('\n');

  const out = head + outLines.join('\n').replace(/\n*$/, '\n');
  fs.mkdirSync(path.dirname(P.distConf), { recursive: true });
  fs.writeFileSync(P.distConf, out);
  log(`· 产物 ${path.relative(ROOT, P.distConf)}  ${Buffer.byteLength(out)} 字节  ${rules.length} 条规则（重定向 ${repointed} 处脚本地址）`);
  return {
    path: 'dist/YoutubeAds.custom.conf',
    bytes: Buffer.byteLength(out),
    sha256: sha256(out),
    rules: rules.length,
    script_lines_repointed: repointed,
    upstream: { url: src.url, sha256: src.sha256, bytes: src.bytes },
  };
}

/* ---------- 3. 主流程 ---------- */

function rawUrl() {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
    if (!m) return null;
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || 'main';
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}/dist/youtube.response.js`;
  } catch (e) { return null; }
}

function main() {
  const upstream = read(P.upstream);
  const cfg = readJSON(P.config);
  const catalog = readJSON(P.catalog);
  const source = readJSONIfExists(P.source, {});
  const ts = new Date().toISOString();
  const url = rawUrl();

  const fn = locateTabFunction(upstream);
  log(`· 定位到上游底部标签过滤函数: ${fn.name}(${fn.params})  [offset ${fn.start}..${fn.end}]  遍历器=${fn.walker}`);

  const repl = replacement(fn);
  const patched = upstream.slice(0, fn.start) + repl + upstream.slice(fn.end + 1);
  const out = header(cfg, catalog, ts, source.upstream_build_line || '(未知)') + patched;

  /* --- 语法检查 --- */
  const tmp = path.join(ROOT, '.build-check.js');
  fs.writeFileSync(tmp, out);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    fs.unlinkSync(tmp);
    const err = (e.stderr ? e.stderr.toString() : e.message).split('\n').slice(0, 4).join('\n');
    die('生成的脚本语法检查失败:\n' + err);
  }
  fs.unlinkSync(tmp);
  log('· 语法检查 node --check 通过');

  /* --- 自检: 定制层必须真的被接上 --- */
  if (!out.includes('globalThis.__ytBottomTabFilter = function')) die('注入失败：产物里没有定制过滤器。');
  if (!repl.includes('__ytBottomTabFilter')) die('注入失败：底部标签函数没有调用定制过滤器。');
  if (patched.includes(fn.src)) die('注入失败：上游原始函数还留在产物里。');
  if (patched.slice(fn.start, fn.start + repl.length) !== repl) die('注入失败：替换的位置不对。');
  const markerLeft = patched.split(MARKER).length - 1;
  if (markerLeft > 0) {
    die(`产物里还残留 ${markerLeft} 处上游特征串 ${MARKER} —— 说明上游别的地方也有这段写死的列表，\n` +
        '  本次替换可能不完整。请人工检查后再放开。');
  }
  if (!patched.includes('"rendererItems"')) die('注入失败：rendererItems 遍历逻辑丢失。');

  /* --- 生成 QX 重写订阅 conf --- */
  const where = url || 'https://raw.githubusercontent.com/<USERNAME>/<REPO>/main/dist/youtube.response.js';
  const confMeta = buildConf(ts, where, readJSONIfExists(P.confSource, {}));
  if (confMeta && !url) {
    log('  ⚠ 还没配 git remote：conf 里的脚本地址是占位符，把 <USERNAME>/<REPO> 换成你的再推上去。');
  }

  fs.mkdirSync(path.dirname(P.dist), { recursive: true });
  fs.writeFileSync(P.dist, out);

  const hide = effectiveHide(cfg);
  const keepMode = (cfg.keep || []).length > 0;
  const manifest = {
    generated_at: ts,
    generator: 'build/build.js',
    upstream: {
      url: source.url,
      referenced_by: source.referenced_by,
      build_line: source.upstream_build_line,
      sha256: sha256(upstream),
      bytes: Buffer.byteLength(upstream),
    },
    config_sha256: sha256(read(P.config)),
    dist: { sha256: sha256(out), bytes: Buffer.byteLength(out), path: 'dist/youtube.response.js' },
    rewrite_conf: confMeta,
    patch: { function: fn.name, strategy: 'semantic-replace', checks: ['node --check', 'filter-wired'] },
    bottom_tabs: {
      mode: keepMode ? 'keep' : 'hide',
      hide_list: hide,
      keep_list: cfg.keep || [],
      keep_unknown: cfg.keepUnknown !== false,
      legacy_switches_active: cfg.disableLegacy === false,
      debug: !!cfg.debug,
    },
  };
  fs.writeFileSync(P.manifest, JSON.stringify(manifest, null, 2) + '\n');

  const confName = 'dist/YoutubeAds.custom.conf';
  fs.writeFileSync(P.qxline, [
    `# 生成时间: ${ts}`,
    '#',
    '# 推荐用法（能自动跟着仓库更新）: 在 QuantumultX 里订阅这个 conf ——',
    `#   本仓库的 dist/YoutubeAds.custom.conf${url ? '，即 ' + url.replace(/dist\/youtube\.response\.js$/, confName) : '（推到 GitHub 后用它的 raw 地址）'}`,
    '#   或在配置的 [rewrite_remote] 加一行:  <conf 的 raw 地址>, tag=moyu-youtube-tabs, enabled=true',
    '#',
    '# 手动用法: 把墨鱼 YoutubeAds.conf 里那一行 script-response-body 的脚本地址换成下面这个 URL',
    '#           （QuantumultX 是 [rewrite_local] 里那一行；Surge / Loon 是模块里的 script-path）',
    `# 未配置 git remote 时地址是占位符：把 <USERNAME>/<REPO> 换成你的账号/仓库名再跑一次 node build/build.js 会自动填好。`,
    '',
    `^https?:\\/\\/youtubei\\.googleapis\\.com\\/youtubei\\/v1\\/(browse|next|player|search|reel\\/reel_watch_sequence|guide|account\\/get_setting|get_watch) url script-response-body ${url || 'https://raw.githubusercontent.com/<USERNAME>/<REPO>/main/dist/youtube.response.js'}`,
    '',
    '# 改完地址后: 客户端「外部资源 → 全部更新」，然后彻底重启 YouTube App。',
    '',
  ].join('\n'));

  log(`· 产物 dist/youtube.response.js  ${manifest.dist.bytes} 字节  sha256=${manifest.dist.sha256.slice(0, 16)}…`);
  log(`· 模式 ${manifest.bottom_tabs.mode}` + (keepMode
    ? `  保留=[${manifest.bottom_tabs.keep_list.join(', ')}]  未知标签${manifest.bottom_tabs.keep_unknown ? '保留' : '移除'}`
    : `  隐藏=[${manifest.bottom_tabs.hide_list.join(', ')}]`));
  if (url) {
    log(`· 脚本地址: ${url}`);
    log(`· QX 订阅: ${url.replace(/dist\/youtube\.response\.js$/, confName)}`);
  } else {
    log('· 未配置 git remote —— dist/qx-rewrite.txt 和 dist/YoutubeAds.custom.conf 里的地址是占位符。');
  }
}

main();
