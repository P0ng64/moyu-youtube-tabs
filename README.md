# moyu-youtube-tabs

把「墨鱼去广告」里的 YouTube 去广告脚本拿下来，改造成**底部标签栏（Bottom Tab）可定制**的版本，
并且能跟着上游更新自动同步。整个东西是一个 git 仓库。

```
上游:  Maasea/sgmodule  Script/Youtube/youtube.response.js
       （墨鱼 ddgksf2013/Rewrite 的 AdBlock/YoutubeAds.conf 就是引用的这个脚本）
本仓库: 在它前面注入一层「定制层」，其余代码原样保留
```

## 目录

```
upstream/youtube.response.js   上游原始脚本（只读，永不修改，用来 diff / 重打补丁）
upstream/source.json           上游地址 + 版本号 + sha256
config/bottom-tabs.json        你的定制配置（由 customize 脚本生成）
build/build.js                 打补丁 + 生成 dist/（自带语法检查和接线自检）
build/tabs.catalog.json        已知底部标签 browseId 目录
scripts/customize.sh           交互式定制 → 改配置 → 自动重新生成 dist/
scripts/sync-upstream.sh       同步上游（有更新就重打补丁 + 生成 + 提交 + 推送）
scripts/install-monthly-sync.sh  装 launchd 任务，每月 1 号自动同步
dist/youtube.response.js       ★ 产物：给客户端用的脚本
dist/qx-rewrite.txt            可直接粘贴的 QuantumultX 重写行
dist/manifest.json             本次生成的元信息（上游版本、sha256、生效的标签清单）
tests/test-bottom-tabs.js      端到端测试：喂假的 guide 响应，验证标签真的被移除
```

## 快速开始

```bash
cd /Users/p0ng/Developer/JustForFun/moyu-youtube-tabs

# 1. 定制（交互式问答，改完自动重新生成 dist/）
./scripts/customize.sh

# 2. 看结果
./scripts/customize.sh --show
cat dist/qx-rewrite.txt          # 里面有可以粘贴的重写行

# 3. 验证一切正常（跑测试）
node tests/test-bottom-tabs.js
```

想反悔：`./scripts/customize.sh` 再跑一遍，或者 `git checkout config dist` 回到上次提交的状态。

## 怎么让手机用上

1. 把本仓库推到 GitHub（public 最省事；private 需要带 token 的 raw 地址）。
   推上去之后 `node build/build.js` 会自动把 `dist/qx-rewrite.txt` 里的地址填成真实 raw 链接。
2. 打开墨鱼 `YoutubeAds.conf`，找到这一行：

   ```
   ^https?:\/\/youtubei\.googleapis\.com\/youtubei\/v1\/(browse|next|player|search|reel\/reel_watch_sequence|guide|account\/get_setting|get_watch) url script-response-body https://raw.githubusercontent.com/Maasea/sgmodule/refs/heads/master/Script/Youtube/youtube.response.js
   ```

   把最后那个 `https://raw.githubusercontent.com/...youtube.response.js` 换成 `dist/qx-rewrite.txt` 里给你的地址。
3. 客户端里「外部资源 → 全部更新」，然后**彻底退出** YouTube 再打开（只切后台不行）。

> 只改了 `script-response-body` 的地址，去广告、后台播放、画中画这些原有功能一个都没动。

## 配置说明（config/bottom-tabs.json）

| 字段 | 含义 |
| --- | --- |
| `mode` | `"hide"` 隐藏清单里的标签；`"keep"` 只保留清单里的标签（其余全移除） |
| `hide` | 黑名单模式的标签 ID 列表 |
| `keep` | 白名单模式要保留的标签 ID 列表 |
| `keepUnknown` | 白名单模式下，**目录里没有的**未知 ID 怎么办：`true` 保留（默认，防止误伤 Google 新功能），`false` 一并移除 |
| `disableLegacy` | `true`（默认）忽略上游自带的 `blockUpload / blockImmersive / blockShorts` 开关，完全按你的清单生效；`false` 时上游开关继续生效（会多藏几个） |
| `debug` | `true` 时在客户端日志里打印每次 guide 响应出现的底部标签 ID（配合客户端日志，用来发现新标签 ID） |
| `catalogExtras` | 给自定义 ID 起名字，格式 `{"ID": "名称"}`。**注意**：被命名的 ID 会被当作「正式标签」，白名单模式下不在 `keep` 里就会被移除 |

## 已知的底部标签 ID（build/tabs.catalog.json）

`verified: true` 的四个是上游脚本自己写死的，肯定对：`FEuploads`（创建/上传 +）、`FEmusic_immersive`（YT Music 样本）、
`FEshorts`（Shorts）、`SPunlimited`。其余的按 InnerTube 惯例列出（`FEwhat_to_watch` 首页、`FEsubscriptions` 订阅等），
**没有在你的手机上逐一验证**：如果你隐藏了某个 ID 却没效果，或者发现目录里没有的 ID，
打开 `debug` 跑一次定制，在客户端日志里看实际打印出来的 ID，再用 customize 脚本的「追加目录里没有的 browseId」加进去。

## 每月自动同步上游

```bash
./scripts/install-monthly-sync.sh          # 装 launchd 任务（每月 1 号 12:30）
./scripts/install-monthly-sync.sh --hour 9 # 换时间
./scripts/uninstall-monthly-sync.sh        # 卸载
```

任务做的事（`scripts/sync-upstream.sh`）：

1. 下载上游脚本，和 `upstream/youtube.response.js` 比 sha256。
2. **没变化**：什么都不做（`--force` 可以强制重新生成）。
3. **有变化**：替换上游文件 → 重新打补丁 → 跑端到端测试 → 更新 `source.json` → git 提交 → 有 remote 就 push。
4. **打不上补丁或测试失败**：自动回滚到上一个能用的版本，写一份 `SYNC_NEEDS_REVIEW.md` 说明怎么修，
   并发一条 macOS 通知。**手机上的脚本不会因此变坏**。

想手动来一次：

```bash
./scripts/sync-upstream.sh            # 自动同步
./scripts/sync-upstream.sh --check    # 只看有没有更新
./scripts/sync-upstream.sh --no-push  # 本地提交不推送
```

日志：`logs/sync.log`（launchd 自己的输出在 `logs/launchd.out.log` / `.err.log`）。

> 只有推到 GitHub 且客户端执行了「外部资源 → 全部更新」，手机上的脚本才会真的换成新版本。
> 没配 remote 的话，同步只在本地提交，需要你自己把 `dist/` 传上去。

## 这层定制是怎么实现的

上游脚本里，处理 `youtubei/v1/guide` 响应的那个函数负责底部导航项：

```js
// 上游原样（压缩后的样子）
function $i(l,{params:e}){let t=["SPunlimited"];
  e.blockUpload&&t.push("FEuploads"), e.blockImmersive&&t.push("FEmusic_immersive"), e.blockShorts&&t.push("FEshorts");
  let n=!1; return ce(l,"rendererItems",i=>{ ... t.includes(c) && (i.rendererItems.splice(r,1), n=!0) }), {bodyChanged:n,stateChanged:!1}}
```

`build/build.js` 不按压缩后的函数名（会被改名）去匹配，而是按**语义特征**定位这个函数
（函数体里有 `["SPunlimited"]`，且同一个函数里有 `rendererItems` / `iconRender` / `browseId`），
用大括号配对取出整个函数，换成调用注入的过滤器：

```js
function $i(l,{params:e}){let _ytTabs=globalThis.__ytBottomTabFilter(e),_ytHit=!1;
  return ce(l,"rendererItems",_ytNode=>{ ... _ytId && _ytTabs(_ytId) && (_ytNode.rendererItems.splice(_ytI,1),_ytHit=!0) }), {bodyChanged:_ytHit,stateChanged:!1}}
```

过滤器本体放在文件最前面（`globalThis.__YT_BOTTOM_TABS__` 就是你的配置），
所以**改配置 = 重新生成这个文件**，脚本行为立刻跟着变。

安全网：
- 生成后先 `node --check` 语法检查，再做一次「接线自检」（确认过滤器真的被调用、上游写死的 `["SPunlimited"]` 已消失）。
- 任一步失败就报错退出，不会产出半成品 `dist/`。
- `tests/test-bottom-tabs.js` 会真的起一个假的 QuantumultX/Surge 运行环境，喂一个手工拼的 protobuf `guide` 响应，
  检查哪些标签被移除了（10 个用例，覆盖黑白名单、未知标签、上游开关、labelRender 形式、YT Music）。

## 常见问题

- **改了配置但手机上没变化**：客户端要「外部资源 → 全部更新」，并且彻底杀掉 YouTube 再打开；若走了 GitHub raw，
  还有 CDN 缓存，等一两分钟或改一次文件名（版本号）再试。
- **Simulator/真机上看不到效果**：底部标签是一次性拉取的，重启 App 才会重新请求 `guide`。
- **白名单模式下标签栏只剩一两个**：这是白名单的预期行为，YouTube 不会自动补回被移除的项。
- **想回到最初的默认行为**：`git checkout config dist`，或把 `disableLegacy` 设回 `false` 且清空两个清单。
