#!/usr/bin/env node
/**
 * scripts/customize.js — 交互式定制 YouTube 底部标签栏。
 *
 * 它会问你几个问题，把答案写进 config/bottom-tabs.json，
 * 然后立刻重新生成 dist/youtube.response.js（去广告脚本同步变化）。
 *
 * 用法:
 *   scripts/customize.sh              交互式定制
 *   scripts/customize.sh --show       只看当前配置
 *   scripts/customize.sh --rebuild    不改配置，只按现有配置重新生成 dist
 *
 * 每个问题后面 [xxx] 是当前值，直接回车 = 保持不变。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CFG = path.join(ROOT, 'config', 'bottom-tabs.json');
const CATALOG = path.join(ROOT, 'build', 'tabs.catalog.json');
const BUILDER = path.join(ROOT, 'build', 'build.js');
const DIST = path.join(ROOT, 'dist', 'youtube.response.js');

const C = { b: '\x1b[1m', d: '\x1b[2m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m' };
const args = process.argv.slice(2);

function loadCfg() {
  const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  c.hide = c.hide || [];
  c.keep = c.keep || [];
  c.catalogExtras = c.catalogExtras || {};
  return c;
}
const CAT = JSON.parse(fs.readFileSync(CATALOG, 'utf8')).items || {};

function describe(cfg) {
  const keepMode = (cfg.keep || []).length > 0;
  const nm = (id) => (CAT[id] ? CAT[id].name : (cfg.catalogExtras && cfg.catalogExtras[id]) || '自定义');
  if (keepMode) {
    console.log(`  模式: ${C.b}只保留白名单${C.r}`);
    console.log(`  保留: ${cfg.keep.map((i) => `${i}(${nm(i)})`).join(', ') || '（空 -> 会移除全部）'}`);
    console.log(`  目录外的未知标签: ${cfg.keepUnknown ? '保留' : '移除'}`);
  } else {
    console.log(`  模式: ${C.b}隐藏黑名单${C.r}`);
    console.log(`  隐藏: ${(cfg.hide || []).map((i) => `${i}(${nm(i)})`).join(', ') || '（空 -> 什么都不隐藏）'}`);
  }
  console.log(`  上游旧开关(屏蔽上传/选段/Shorts): ${cfg.disableLegacy ? '被忽略，完全按上面的清单' : '仍然生效'}`);
  console.log(`  调试日志: ${cfg.debug ? '开' : '关'}`);
}

/* ---------- 交互 ----------
 * 用“行队列 + 等待者”而不是 rl.question：这样交互输入和「管道/粘贴多行」都能正常工作，
 * 输入提前结束时（EOF）自动用默认值继续。
 */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lineQueue = [];
const waiters = [];
let eof = false;
rl.on('line', (l) => { const w = waiters.shift(); if (w) w(l); else lineQueue.push(l); });
rl.on('close', () => { eof = true; while (waiters.length) waiters.shift()(''); });

function ask(q) {
  process.stdout.write(q);
  return new Promise((res) => {
    if (lineQueue.length) return res(lineQueue.shift().trim());
    if (eof) return res('');
    waiters.push((a) => res((a || '').trim()));
  });
}
async function yesNo(q, def) {
  const hint = def ? 'Y/n' : 'y/N';
  const a = (await ask(`${q} [${hint}] `)).toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes' || a === '是' || a === '1';
}

async function interactive() {
  const cfg = loadCfg();

  console.log(`\n${C.b}=== YouTube 底部标签栏定制 (墨鱼去广告脚本) ===${C.r}`);
  console.log(`${C.d}当前配置 (config/bottom-tabs.json):${C.r}`);
  describe(cfg);
  console.log(`${C.d}每个问题直接回车 = 保持当前值。Ctrl-C 随时放弃，不会改任何东西。${C.r}\n`);

  /* 1. 模式 */
  const curKeep = (cfg.keep || []).length > 0;
  console.log(`${C.b}[1/6] 模式${C.r}`);
  console.log('  1) 隐藏 指定的标签（黑名单，其它标签都留着）');
  console.log('  2) 只保留 指定的标签（白名单，其它标签全部移除）');
  let modeAns = await ask(`选择 [${curKeep ? 2 : 1}]: `);
  if (modeAns !== '1' && modeAns !== '2') modeAns = curKeep ? '2' : '1';
  const keepMode = modeAns === '2';
  console.log(`  -> ${keepMode ? '白名单' : '黑名单'}\n`);

  /* 2. 逐个标签 */
  const ids = Object.keys(CAT);
  const picked = keepMode ? cfg.keep.slice() : cfg.hide.slice();
  const extras = new Set(Object.keys(cfg.catalogExtras));
  const src = keepMode ? cfg.keep : cfg.hide;

  console.log(`${C.b}[2/6] 逐个确认${C.r}${C.d}（目录里有 ${ids.length} 个已知标签）${C.r}`);
  for (const id of ids) {
    const info = CAT[id];
    const cur = src.indexOf(id) >= 0;
    const tag = info.app === 'music' ? 'YT Music' : 'YouTube';
    const q = keepMode
      ? `  保留 ${C.c}${info.name}${C.r} (${id}, ${tag})?`
      : `  隐藏 ${C.c}${info.name}${C.r} (${id}, ${tag})?`;
    const ans = await yesNo(q, cur);
    const i = picked.indexOf(id);
    if (ans && i < 0) picked.push(id);
    if (!ans && i >= 0) picked.splice(i, 1);
  }
  console.log();

  /* 3. 自定义 ID */
  console.log(`${C.b}[3/6] 追加目录里没有的 browseId${C.r}`);
  console.log(`${C.d}  逗号分隔，可留空。打开 [6/6] 的调试日志后，在客户端日志里能看到真实 ID。${C.r}`);
  const extraRaw = await ask('  追加 ID: ');
  const extraIds = extraRaw.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]+$/.test(s));
  for (const id of extraIds) if (picked.indexOf(id) < 0) picked.push(id);
  if (extraIds.length) {
    console.log(`  已加入: ${extraIds.join(', ')}`);
    const nameRaw = await ask('  给它们起名字？可留空 (格式 ID=名称, ID2=名称2): ');
    for (const pair of nameRaw.split(/[,，]+/)) {
      const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(pair);
      if (m) { cfg.catalogExtras[m[1]] = m[2]; extras.add(m[1]); }
    }
    // 自定义 ID 不自动算进目录：为避免歧义，这里只提示
    console.log(`${C.d}  提示: 被命名的 ID 会被当作「正式标签」看待，白名单模式下不在白名单里就会被移除。${C.r}`);
  }
  console.log();

  /* 4. 未知标签 */
  let keepUnknown = cfg.keepUnknown !== false;
  if (keepMode) {
    console.log(`${C.b}[4/6] 目录外的未知标签${C.r}`);
    console.log(`${C.d}  例: Google 新加了一个底部标签，但目录里还没有它。${C.r}`);
    keepUnknown = await yesNo('  保留这类未知标签?', keepUnknown);
    console.log(`  -> ${keepUnknown ? '保留' : '一并移除'}\n`);
  } else {
    console.log(`${C.b}[4/6] 目录外的未知标签${C.r}${C.d}（黑名单模式只移除你点名的 ID，其它一律保留，无需选择）${C.r}\n`);
  }

  /* 5. 上游旧开关 */
  console.log(`${C.b}[5/6] 上游自带的屏蔽开关${C.r}`);
  console.log(`${C.d}  上游脚本默认会藏掉「创建/上传」「YT Music 样本」「SPunlimited」，Surge/Loon 还可以用模块参数控制。${C.r}`);
  const disableLegacy = await yesNo('  忽略这些上游开关，完全按你上面的清单生效?', cfg.disableLegacy !== false);
  console.log(`  -> ${disableLegacy ? '忽略上游开关（你的清单说了算）' : '上游开关仍然生效（可能会多藏几个）'}\n`);

  /* 6. 调试 */
  console.log(`${C.b}[6/6] 调试日志${C.r}`);
  console.log(`${C.d}  开启后，客户端日志里会打印每次 guide 响应里出现的底部标签 ID 和名字。${C.r}`);
  const debug = await yesNo('  打开调试日志?', !!cfg.debug);

  /* 汇总确认 */
  const next = {
    version: cfg.version || 1,
    mode: keepMode ? 'keep' : 'hide',
    hide: keepMode ? [] : picked,
    keep: keepMode ? picked : [],
    keepUnknown,
    disableLegacy,
    debug,
    catalogExtras: cfg.catalogExtras,
    updatedAt: new Date().toISOString(),
    note: '由 scripts/customize.sh 生成；改完会重新生成 dist/youtube.response.js',
  };

  console.log(`\n${C.b}=== 将要写入的配置 ===${C.r}`);
  describe(next);
  const ok = await yesNo(`\n写入并重新生成脚本?`, true);
  if (!ok) { console.log('已放弃，什么都没改。'); return 1; }

  fs.writeFileSync(CFG, JSON.stringify(next, null, 2) + '\n');
  console.log(`\n${C.g}✔ 已写入 ${path.relative(ROOT, CFG)}${C.r}`);
  return 0;
}

/* ---------- 生成 + 汇报 ---------- */
function rebuild() {
  console.log(`\n${C.b}=== 重新生成 dist/youtube.response.js ===${C.r}`);
  try {
    execFileSync(process.execPath, [BUILDER], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error(`\n${C.y}✖ 生成失败（配置已写入，但脚本没变）。修好后再跑: scripts/customize.sh --rebuild${C.r}`);
    return 1;
  }
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'manifest.json'), 'utf8'));
  const bytes = fs.statSync(DIST).size;
  console.log(`\n${C.b}结果${C.r}`);
  if (m.bottom_tabs.mode === 'keep') {
    console.log(`  底部标签栏将只保留: ${m.bottom_tabs.keep_list.join(', ') || '（空，全部移除）'}`);
  } else {
    console.log(`  底部标签栏将移除: ${m.bottom_tabs.hide_list.join(', ') || '（无）'}`);
  }
  console.log(`  产物: dist/youtube.response.js (${bytes} 字节, sha256 ${m.dist.sha256.slice(0, 12)}…)`);
  console.log(`\n${C.b}接下来（只需做一次/每次改完做一次）${C.r}`);
  console.log('  1. 让手机能用上：把本仓库推到 GitHub 后，在 QuantumultX 订阅这个 conf：');
  console.log(`     ${C.c}dist/YoutubeAds.custom.conf${C.r}  <- 地址见 ${C.c}dist/qx-rewrite.txt${C.r} 开头两行`);
  console.log('     （配置里写: [rewrite_remote] 加一行 "<conf 的 raw 地址>, tag=moyu-youtube-tabs, enabled=true"）');
  console.log('     或者：把墨鱼 YoutubeAds.conf 里那行 script-response-body 的地址换成 dist/youtube.response.js 的地址');
  console.log('  2. 客户端里执行「外部资源 → 全部更新」（只改了标签配置时，脚本变了、conf 没变，也要更新一次）');
  console.log('  3. 彻底退出并重开 YouTube（只切后台不行，底部标签是启动时拉的）');
  return 0;
}

/* ---------- 入口 ---------- */
(async () => {
  try {
    if (args.includes('--show')) { console.log(`${C.b}当前配置:${C.r}`); describe(loadCfg()); return; }
    if (args.includes('--rebuild')) process.exit(rebuild());
    const rc = await interactive();
    rl.close();
    if (rc === 0) process.exit(rebuild());
    process.exit(rc);
  } catch (e) {
    console.error('出错了: ' + e.message);
    process.exit(1);
  }
})();
