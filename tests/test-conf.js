#!/usr/bin/env node
/**
 * tests/test-conf.js — 验证 QuantumultX 重写订阅 conf（dist/YoutubeAds.custom.conf）没被改坏。
 *
 * 重点：我们只应该「换掉脚本地址」，别的（注释、hostname、每条规则的正则和动作）必须和墨鱼那份逐字一致，
 * 否则手机上的去广告行为就跟原来不一样了。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UP = path.join(ROOT, 'upstream', 'YoutubeAds.conf');
const OUT = path.join(ROOT, 'dist', 'YoutubeAds.custom.conf');
const MANIFEST = path.join(ROOT, 'dist', 'manifest.json');
const DIST = path.join(ROOT, 'dist', 'youtube.response.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`✔ ${name}`); pass++; }
  else { console.log(`✖ ${name}${detail ? '\n    ' + detail : ''}`); fail++; }
}

function gitRawUrl() {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
    if (!m) return null;
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || 'main';
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}/dist/youtube.response.js`;
  } catch (e) { return null; }
}

const isComment = (l) => !l.trim() || /^\s*#/.test(l);
const isRule = (l) => !isComment(l) && /\surl\s+/.test(l);
const isDirective = (l) => !isComment(l) && !/\surl\s+/.test(l);

const conf = fs.readFileSync(OUT, 'utf8');
const up = fs.readFileSync(UP, 'utf8');
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

const confLines = conf.split('\n');
const upLines = up.split('\n');
const confRules = confLines.filter(isRule);
const upRules = upLines.filter(isRule);
const confDirectives = confLines.filter(isDirective);
const upDirectives = upLines.filter(isDirective);

/* --- 1. 基本形态 --- */
check('conf 文件存在且以换行结尾', conf.length > 500 && conf.endsWith('\n'));
check('文件头有我们的标记（自动生成/定制版脚本/上游重写/生成时间）',
  ['自动生成', '定制版脚本', '上游重写', '生成时间'].every((k) => conf.includes(k)));
check('注释里说明了用法（[rewrite_remote] / MITM）', conf.includes('rewrite_remote') && conf.includes('MITM'));

/* --- 2. hostname / 指令行与上游逐字一致 --- */
check('hostname 指令行与上游完全一致',
  upDirectives.length === confDirectives.length && upDirectives.every((l, i) => l === confDirectives[i]),
  `上游: ${JSON.stringify(upDirectives)}\n    产物: ${JSON.stringify(confDirectives)}`);

/* --- 3. 规则条数与顺序 --- */
check(`规则条数与上游一致（${upRules.length} 条）`, confRules.length === upRules.length,
  `上游 ${upRules.length} 条 / 产物 ${confRules.length} 条`);

/* --- 4. 除脚本地址外，每条规则逐字一致；正则可编译；动作合法 --- */
const ACTIONS = /^\s*url\s+(reject|reject-\d+|302|307|script-response-body|script-request-body|script-response-header|script-request-header)(\s|$)/;
let patternMismatch = [], badRegex = [], badAction = [], scriptUrls = [];
confRules.forEach((line, i) => {
  const upLine = upRules[i] || '';
  const [pat, rest] = [line.split(/\s+url\s+/)[0], line.split(/\s+url\s+/).slice(1).join(' url ')];
  const upPat = upLine.split(/\s+url\s+/)[0];
  if (pat !== upPat) patternMismatch.push(`#${i + 1} 产物: ${pat}\n        上游: ${upPat}`);
  try { new RegExp(pat); } catch (e) { badRegex.push(`#${i + 1} ${pat} -> ${e.message}`); }
  if (!ACTIONS.test(' url ' + rest)) badAction.push(`#${i + 1} ${line}`);
  const m = /^script-[a-z]+-[a-z]+\s+(\S+)$/.exec(rest.trim());
  if (m) scriptUrls.push(m[1]);
});
check('每条规则的正则与上游逐字一致', patternMismatch.length === 0, patternMismatch.join('\n    '));
check('每条规则的正则都能编译（客户端不会报错）', badRegex.length === 0, badRegex.join('\n    '));
check('每条规则的动作都是合法写法', badAction.length === 0, badAction.join('\n    '));

/* --- 5. 脚本地址被换成我们的定制版 --- */
const expected = gitRawUrl();
check('conf 里恰好有 1 处 script 行（和上游一样）', scriptUrls.length === 1, JSON.stringify(scriptUrls));
if (expected) {
  check('script 行指向本仓库的 dist/youtube.response.js', scriptUrls[0] === expected,
    `期望: ${expected}\n    实际: ${scriptUrls[0]}`);
} else {
  check('script 行是占位符（未配 remote，符合预期）', /<USERNAME>\/<REPO>/.test(scriptUrls[0] || ''), scriptUrls[0]);
}
check('没有残留上游脚本地址（非注释行里不再出现 Maasea/sgmodule）',
  !confRules.some((l) => /Maasea\/sgmodule/.test(l)));
check('上游脚本文件本身在本地确实存在（产物和它同一个 dist 目录）', fs.existsSync(DIST));

/* --- 6. manifest 记录与实际一致 --- */
check('manifest.rewrite_conf 记录了 conf 的 sha256 与规则数',
  manifest.rewrite_conf && manifest.rewrite_conf.sha256 === require('crypto').createHash('sha256').update(conf).digest('hex')
  && manifest.rewrite_conf.rules === confRules.length,
  JSON.stringify(manifest.rewrite_conf));

/* --- 7. 只改了脚本地址：非注释行的差异应当只有那一行 --- */
const diffLines = confRules.filter((l, i) => l !== upRules[i]);
check('规则里只有 script 那一行与上游不同', diffLines.length === 1 && /script-response-body/.test(diffLines[0]),
  diffLines.join('\n    '));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
