#!/usr/bin/env node
/**
 * tests/test-scripts.js — 给 scripts/*.sh 做体检。
 *
 * 关键一条：macOS 自带的是 bash 3.2，它会把「$VAR 后面紧跟着的中文字符」当成变量名的一部分，
 * 于是 `echo "没找到 $PLIST，..."` 在 set -u 下直接报 unbound variable 而不是输出文字。
 * 这类 bug 用 bash -n 查不出来，只能靠扫。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sh')).sort();

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`✔ ${name}`); pass++; }
  else { console.log(`✖ ${name}${detail ? '\n    ' + detail : ''}`); fail++; }
}

check('scripts/ 下有 shell 脚本', files.length > 0, files.join(', '));

for (const f of files) {
  const p = path.join(DIR, f);
  const src = fs.readFileSync(p, 'utf8');

  check(`${f}: 有 shebang`, /^#!\/usr\/bin\/env bash|^#!\/bin\/bash/.test(src), src.split('\n')[0]);
  check(`${f}: 可执行位`, (fs.statSync(p).mode & 0o111) !== 0, 'chmod +x ' + f);

  // 语法：显式用 /bin/bash（macOS 自带 3.2）检查，避免开发机装了 bash 5 就以为没问题
  let syntaxErr = null;
  try {
    execFileSync('/bin/bash', ['-n', p], { stdio: 'pipe' });
  } catch (e) { syntaxErr = (e.stderr || '').toString().split('\n').slice(0, 3).join('\n    '); }
  check(`${f}: /bin/bash -n 语法检查通过（兼容系统自带 bash 3.2）`, !syntaxErr, syntaxErr || '');

  // $VAR / $1 后面直接跟非 ASCII 字符 -> bash 3.2 会当成变量名的一部分
  const badCjk = [];
  src.split('\n').forEach((line, i) => {
    const m = line.match(/\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])(?=[^\x00-\x7f])/);
    if (m) badCjk.push(`line ${i + 1}: ${line.trim().slice(0, 110)}`);
  });
  check(`${f}: 没有「$VAR 后面紧跟中文字符」（bash 3.2 陷阱）`, badCjk.length === 0,
    badCjk.join('\n    ') + '\n    改成 ${VAR} 这种带大括号的写法');

  // bash 4+ 才有的语法
  const modern = [];
  if (/^\s*declare\s+-A\b/m.test(src)) modern.push('declare -A（关联数组，bash 4+）');
  if (/\bmapfile\b|\breadarray\b/.test(src)) modern.push('mapfile/readarray（bash 4+）');
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*(\^\^|,,)\}/.test(src)) modern.push('${var^^}/${var,,} 大小写转换（bash 4+）');
  check(`${f}: 没有用到 bash 4+ 独有语法`, modern.length === 0, modern.join('\n    '));

  // 用 set -u 的脚本：被赋值为「空数组」的变量，展开时必须用 ${arr[@]+"..."} 形式
  if (/set -[a-z]*u/.test(src)) {
    const emptyArrays = new Set();
    src.replace(/^\s*([A-Za-z_][A-Za-z0-9_]*)=\(\s*\)/gm, (m, n) => { emptyArrays.add(n); return m; });
    const bare = [];
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}/g)) {
        if (emptyArrays.has(m[1]) && !/\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\+/.test(line)) {
          bare.push(`line ${i + 1}: ${line.trim().slice(0, 110)}`);
        }
      }
    });
    check(`${f}: set -u 下空数组展开有保护（\${arr[@]+"..."}）`, bare.length === 0, bare.join('\n    '));
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
