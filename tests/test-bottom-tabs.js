#!/usr/bin/env node
/**
 * tests/test-bottom-tabs.js — 端到端验证「定制层」真的在改底部标签栏。
 *
 * 做法（不是「看起来对」，是真的跑）:
 *   1. 往 config/bottom-tabs.json 写入一组测试配置
 *   2. 跑 node build/build.js 重新生成 dist/
 *   3. 在 vm 里用假的 QuantumultX / Surge 全局变量运行 dist 脚本
 *   4. 喂一个手工构造的 protobuf `youtubei/v1/guide` 响应（含若干底部标签）
 *   5. 解出返回的响应，检查「哪些标签被移除了」是否符合预期
 *
 * 跑完会恢复原配置并重新生成一次 dist。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CFG = path.join(ROOT, 'config', 'bottom-tabs.json');
const BUILDER = path.join(ROOT, 'build', 'build.js');
const DIST = path.join(ROOT, 'dist', 'youtube.response.js');
const UPSTREAM = path.join(ROOT, 'upstream', 'youtube.response.js');

const UA_VIDEO = 'com.google.ios.youtube/19.29.1 (iPhone; U; CPU iPhone OS 17_5 like Mac OS X)';
const UA_MUSIC = 'com.google.ios.youtubemusic/7.30.1 (iPhone; U; CPU iPhone OS 17_5 like Mac OS X)';

/* ---------- 在 vm 里构造 / 解析 protobuf 的工具 ---------- */
const PRELUDE = `
globalThis.__pb = (function () {
    function varint(n) { var o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; }
    function tag(no, wt) { return varint(no * 8 + wt); }
    function ld(no, bytes) { return tag(no, 2).concat(varint(bytes.length), bytes); }
    function str(s) { var a = [], i; for (i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 255); return a; }
    return { varint: varint, tag: tag, ld: ld, str: str };
})();
/* 构造 guide 响应: Guide{ iconItems(6) -> Item{ guideSectionRenderer(117866661)
   -> GuideSectionRenderer{ rendererItems(1) -> RendererItem{ iconRender(318370163)|labelRender(117501096)
   -> { browseId(1) } } } } } */
globalThis.__mkGuide = function (ids, useLabel) {
    var pb = globalThis.__pb, acc = [], i;
    for (i = 0; i < ids.length; i++) {
        var entry = pb.ld(1, pb.str(ids[i]));
        var ritem = pb.ld(useLabel ? 117501096 : 318370163, entry);
        acc = acc.concat(pb.ld(1, ritem));
    }
    var item = pb.ld(117866661, acc);
    return new Uint8Array(pb.ld(6, item));
};
/* 新 UI (2026-10) 的形状: Guide{ items(4) -> Items1{ pivotBarRenderer(117866661)
   -> PivotBarRenderer{ items(1) -> Items2{ pivotBarItemRenderer(117501096)
                                          | pivotBarIconOnlyItemRenderer(318370163) }
   -> PivotBarItemRenderer{ pivotIdentifier(1), navigationEndpoint(2), title(4), targetId(10) } } } } }
   注意：每个条目必须是独立的 field-1 条目（重复字段），不能拼成一条，否则旧的 schema 会把它解成一个项。 */
globalThis.__mkPivotGuide = function (ids, opts) {
    var pb = globalThis.__pb, acc = [], i;
    opts = opts || {};
    for (i = 0; i < ids.length; i++) {
        var id = ids[i];
        var body = pb.ld(1, pb.str(id))
            .concat(pb.ld(2, pb.ld(48687626, pb.ld(2, pb.str(id)))))
            .concat(pb.ld(4, pb.ld(75730170, pb.ld(2, pb.str('title-' + id)))))
            .concat(pb.ld(10, pb.str('pivot-' + i)));
        var wrapper = (opts.iconOnly || []).indexOf(id) >= 0 ? 318370163 : 117501096;
        acc = acc.concat(pb.ld(1, pb.ld(wrapper, body)));
    }
    return new Uint8Array(pb.ld(4, pb.ld(117866661, acc)));
};
/* 从响应字节里捞出所有可打印 ASCII 串（用来既看 tab ID，也验证 title/targetId 这些未知字段有没有留住） */
globalThis.__allStrings = function (bytes) {
    var out = [], cur = '', i, b, ok;
    for (i = 0; i < bytes.length; i++) {
        b = bytes[i];
        ok = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b === 45 || b === 46;
        if (ok) cur += String.fromCharCode(b);
        else { if (cur.length >= 5) out.push(cur); cur = ''; }
    }
    if (cur.length >= 5) out.push(cur);
    return out;
};
`;

/** 用假客户端跑一次 dist 脚本，返回处理后的标签列表 */
function runScript(ids, opts = {}) {
    const code = fs.readFileSync(DIST, 'utf8');
    const platform = opts.platform || 'qx';
    const ctx = { console: console, TextDecoder: TextDecoder, TextEncoder: TextEncoder };
    ctx.$prefs = { valueForKey: () => null, setValueForKey: () => {} };
    ctx.$persistentStore = { read: () => null, write: () => {} };
    ctx.$notify = () => {};
    ctx.$httpClient = { get: () => {}, post: () => {} };
    if (platform === 'qx') ctx.$task = { fetch: () => {} };
    if (opts.argument !== undefined) ctx.$argument = opts.argument;
    vm.createContext(ctx);
    vm.runInContext(PRELUDE, ctx);

    ctx.$request = {
        url: 'https://youtubei.googleapis.com/youtubei/v1/guide?prettyPrint=false&alt=proto',
        headers: { 'user-agent': opts.music ? UA_MUSIC : UA_VIDEO },
    };
    ctx.__IDS = ids;
    ctx.__LABEL = !!opts.useLabel;
    ctx.__SHAPE = opts.shape || 'legacy';
    ctx.__ICON_ONLY = opts.iconOnly || [];
    // Surge 用 $response.body 传二进制体，QuantumultX/Loon 用 $response.bodyBytes
    const bodyKey = platform === 'surge' ? 'body' : 'bodyBytes';
    vm.runInContext(`globalThis.$response = { ${bodyKey}: (globalThis.__SHAPE === 'pivot'
        ? globalThis.__mkPivotGuide(globalThis.__IDS, { iconOnly: globalThis.__ICON_ONLY })
        : globalThis.__mkGuide(globalThis.__IDS, globalThis.__LABEL)) };`, ctx);

    let done = null;
    ctx.$done = (r) => { done = r; };
    vm.runInContext(code, ctx, { filename: 'dist/youtube.response.js' });

    if (!done) throw new Error('脚本没有调用 $done');
    const body = done.bodyBytes || done.body;                          // QuanX: bodyBytes / Surge: body
    if (!body) { lastStrings = []; return ids.slice(); }               // 没有回写 = 一个标签都没动
    ctx.__out = body;
    const all = vm.runInContext('globalThis.__allStrings(new Uint8Array(globalThis.__out))', ctx);
    lastStrings = all;
    return all.filter((s) => /^(FE|SP)[A-Za-z0-9_]+$/.test(s));
}

function build() {
    execFileSync(process.execPath, [BUILDER, '--quiet'], { cwd: ROOT, stdio: 'pipe' });
}
function writeCfg(cfg) {
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');
}

/* ---------- 测试用例 ---------- */
const ALL = ['FEwhat_to_watch', 'FEshorts', 'FEuploads', 'FEsubscriptions', 'FElibrary', 'SPunlimited', 'FEmusic_home', 'FEmusic_immersive', 'FEnovel_feature'];
let lastStrings = [];

const CASES = [
    {
        name: 'hide 模式 + 忽略上游旧开关 (默认配置)',
        cfg: { version: 1, mode: 'hide', hide: ['SPunlimited', 'FEuploads', 'FEmusic_immersive'], keep: [], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(ALL),
        expect: ['FEwhat_to_watch', 'FEshorts', 'FEsubscriptions', 'FElibrary', 'FEmusic_home', 'FEnovel_feature'],
    },
    {
        name: 'hide 模式 + 只隐藏 Shorts 和上传',
        cfg: { version: 1, mode: 'hide', hide: ['FEshorts', 'FEuploads'], keep: [], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(ALL),
        expect: ['FEwhat_to_watch', 'FEsubscriptions', 'FElibrary', 'SPunlimited', 'FEmusic_home', 'FEmusic_immersive', 'FEnovel_feature'],
    },
    {
        name: 'hide 模式 + 隐藏自定义/未知 ID',
        cfg: { version: 1, mode: 'hide', hide: ['FEnovel_feature'], keep: [], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(ALL),
        expect: ['FEwhat_to_watch', 'FEshorts', 'FEuploads', 'FEsubscriptions', 'FElibrary', 'SPunlimited', 'FEmusic_home', 'FEmusic_immersive'],
    },
    {
        name: 'keep 白名单模式 (保留 首页+订阅, 未知标签保留)',
        cfg: { version: 1, mode: 'keep', hide: [], keep: ['FEwhat_to_watch', 'FEsubscriptions'], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(ALL),
        expect: ['FEwhat_to_watch', 'FEsubscriptions', 'FEnovel_feature'],
    },
    {
        name: 'keep 白名单模式 (未知标签也移除)',
        cfg: { version: 1, mode: 'keep', hide: [], keep: ['FEwhat_to_watch', 'FEsubscriptions'], keepUnknown: false, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(ALL),
        expect: ['FEwhat_to_watch', 'FEsubscriptions'],
    },
    {
        name: 'keep 白名单模式 + 自定义 ID 写进白名单',
        cfg: { version: 1, mode: 'keep', hide: [], keep: ['FEmusic_home', 'FEnovel_feature'], keepUnknown: false, disableLegacy: true, debug: false, catalogExtras: { FEnovel_feature: '新功能标签' } },
        run: () => runScript(ALL),
        expect: ['FEmusic_home', 'FEnovel_feature'],
    },
    {
        name: 'keep 白名单模式 + 被 catalogExtras 命名的 ID 视作正式标签(不在白名单则移除)',
        cfg: { version: 1, mode: 'keep', hide: [], keep: ['FEmusic_home'], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: { FEnovel_feature: '新功能标签' } },
        run: () => runScript(ALL),
        expect: ['FEmusic_home'],
    },
    {
        name: 'disableLegacy=false 时上游旧开关仍然生效 (Surge + $argument)',
        cfg: { version: 1, mode: 'hide', hide: [], keep: [], keepUnknown: true, disableLegacy: false, debug: false, catalogExtras: {} },
        run: () => runScript(ALL, { platform: 'surge', argument: '{"blockShorts":true}' }),
        expect: ['FEwhat_to_watch', 'FEsubscriptions', 'FElibrary', 'FEmusic_home', 'FEnovel_feature'],
    },
    {
        name: 'labelRender 形式的标签项也能被识别',
        cfg: { version: 1, mode: 'hide', hide: ['FEshorts'], keep: [], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(ALL, { useLabel: true }),
        expect: ['FEwhat_to_watch', 'FEuploads', 'FEsubscriptions', 'FElibrary', 'SPunlimited', 'FEmusic_home', 'FEmusic_immersive', 'FEnovel_feature'],
    },
    {
        name: 'YouTube Music 客户端 + 隐藏 YT Music 样本页',
        cfg: { version: 1, mode: 'hide', hide: ['FEmusic_immersive', 'SPunlimited'], keep: [], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(['FEmusic_home', 'FEmusic_explore', 'FEmusic_library_landing', 'FEmusic_immersive', 'SPunlimited'], { music: true }),
        expect: ['FEmusic_home', 'FEmusic_explore', 'FEmusic_library_landing'],
    },

    /* ---- 2026-10 新 UI: guide 里不再有 guideSectionRenderer.rendererItems，
       换成 pivotBarRenderer.items[].pivotBarItemRenderer.pivotIdentifier ---- */
    {
        name: '新UI(pivot): 白名单 首页/订阅/我的 —— 三个都要活下来',
        cfg: { version: 1, mode: 'keep', hide: [], keep: ['FEwhat_to_watch', 'FEsubscriptions', 'FElibrary'], keepUnknown: false, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(['FEwhat_to_watch', 'FEshorts', 'FEexplore', 'FEsubscriptions', 'FElibrary'], { shape: 'pivot' }),
        expect: ['FEwhat_to_watch', 'FEsubscriptions', 'FElibrary'],
        expectStrings: ['title-FElibrary', 'pivot-4'],   // title / targetId 这些「未知字段」必须原样保留
    },
    {
        name: '新UI(pivot): 白名单 + 未知 ID 保留（keepUnknown=true，服务端新增的 tab 不会被误杀）',
        cfg: { version: 1, mode: 'keep', hide: [], keep: ['FEwhat_to_watch'], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(['FEwhat_to_watch', 'FEshorts', 'FEqux_unknown'], { shape: 'pivot' }),
        expect: ['FEwhat_to_watch', 'FEqux_unknown'],
    },
    {
        name: '新UI(pivot): 黑名单隐藏 explore/shorts',
        cfg: { version: 1, mode: 'hide', hide: ['FEexplore', 'FEshorts'], keep: [], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(['FEwhat_to_watch', 'FEshorts', 'FEexplore', 'FEsubscriptions', 'FElibrary'], { shape: 'pivot' }),
        expect: ['FEwhat_to_watch', 'FEsubscriptions', 'FElibrary'],
    },
    {
        name: '新UI(pivot): icon-only 变体(318370163) 也能识别，且其余项字段完好',
        cfg: { version: 1, mode: 'hide', hide: ['FEshorts'], keep: [], keepUnknown: true, disableLegacy: true, debug: false, catalogExtras: {} },
        run: () => runScript(['FEwhat_to_watch', 'FEshorts', 'FElibrary'], { shape: 'pivot', iconOnly: ['FEshorts', 'FElibrary'] }),
        expect: ['FEwhat_to_watch', 'FElibrary'],
        expectStrings: ['title-FElibrary', 'pivot-2'],
    },
];

/* ---------- 跑 ---------- */
const originalCfg = fs.readFileSync(CFG, 'utf8');
const upstreamSha0 = crypto.createHash('sha256').update(fs.readFileSync(UPSTREAM)).digest('hex');
let pass = 0, fail = 0;

try {
    for (const c of CASES) {
        writeCfg(c.cfg);
        build();
        let got;
        try { got = c.run(); } catch (e) { console.log(`✖ ${c.name}\n    异常: ${e.message}`); fail++; continue; }
        const uniq = (a) => Array.from(new Set(a));
        const gotS = JSON.stringify(uniq(got).sort());
        const expS = JSON.stringify(c.expect.slice().sort());
        // 字符串扫描会把紧随其后的长度字节也算进来，所以用「包含」而不是「相等」
        const missing = (c.expectStrings || []).filter((s) => !lastStrings.some((x) => x.indexOf(s) >= 0));
        if (gotS === expS && missing.length === 0) { console.log(`✔ ${c.name}`); pass++; }
        else {
            fail++;
            console.log(`✖ ${c.name}`);
            console.log(`    期望保留: ${c.expect.join(', ')}`);
            console.log(`    实际保留: ${uniq(got).join(', ')}`);
            if (missing.length) {
                console.log(`    丢失的未知字段: ${missing.join(', ')}（说明重新编码时字段没保住）`);
                console.log(`    输出里的字符串: ${JSON.stringify(lastStrings)}`);
            }
        }
    }
} finally {
    fs.writeFileSync(CFG, originalCfg);
    build();
}

const upstreamSha1 = crypto.createHash('sha256').update(fs.readFileSync(UPSTREAM)).digest('hex');
if (upstreamSha0 !== upstreamSha1) { console.log('✖ upstream/youtube.response.js 在测试中被改动了！'); fail++; }
else console.log('✔ 上游原始脚本全程未被修改，且已按原配置重新生成 dist/');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
