# zotero-llm-bridge

**给 `llm-for-zotero` 的免密钥联网搜索 + 豆包（Doubao）桥接。非官方补丁项目。**

> 本仓库提供**两个可独立安装的组件**，也可以只装其中一个。
> 非官方项目。不由 `llm-for-zotero` 作者（Yile Wang）维护或背书。
> 上游：<https://github.com/yilewang/llm-for-zotero>
> 浏览器桥：<https://github.com/yilewang/sync-for-zotero>
> 完整归属声明见 [NOTICE.md](NOTICE.md)。

## 两个组件

| 组件 | 装到哪 | 解决什么 | 装它需要 |
|---|---|---|---|
| **Zotero 补丁** | Zotero 插件 `llm-for-zotero` | 联网搜索免注册可用；agent 检索空转不再把半截答案丢掉 | Zotero + Python 3 |
| **豆包桥接扩展**<br>`Zotero LLM Bridge (Unofficial)` | Chrome / Edge | 把豆包等网页聊天的回答回传进 Zotero 笔记；补上豆包图标 | 浏览器 + 上面那个补丁 |

想只要联网搜索，就装第一个。要把豆包的回答也带进 Zotero，两个都装。

两件事一起做：用免费引擎联网搜文献，并把豆包的回答直接写进 Zotero 笔记。本仓库只提供**补丁脚本**和**一键安装器**，不含上游源码。

---

## 这个项目解决什么

`llm-for-zotero` 是个很完善的 Zotero AI 插件，但有两个真实使用中的问题。

### 1. 联网搜索必须注册第三方服务

插件的联网搜索默认依赖 Tavily。本项目替换 `createConfiguredWebAccessProvider()`，接上一个自建的多引擎 provider（Bing 三域名 → 360 搜索 → DuckDuckGo → Mojeek），任何一步返回结果即停止尝试。

**这里有个容易被误解的点**：Tavily 官方提供每月 1000 credits 免费额度，且不需要信用卡，作者也不售卖 API key。所以这些补丁省掉的是**注册这一步**，不是规避付费——它替换的是一个本来就免费的服务。

同时修掉三个使用中暴露的病态行为：

| 改动 | 作用 |
|---|---|
| `enrichResults()` | 搜到结果后并发抓取正文替换 snippet。初版只返回搜索引擎结果页的 meta description，中文商业站那一栏几乎全是营销话术——平均每条 58 字符 vs Tavily 的 513 字符。模型读到的全是垃圾，于是合理地判定「搜不到」，换词重搜，跑到 `MAX_AGENT_ROUNDS = 24` 上限。 |
| 单次运行账本 + 改写检测 | 每次 `web_search` 按词元集合记入 ledger；相似度 ≥ 0.6 判为改写重复，在工具结果里回一句「和第 N 条重合 86%，重跑不会产生新信息」。**约束写在工具返回值里，而不是改系统提示词**——改提示词换个模型就失效，写在工具契约里任何 Tool-Call 模型都会读到。 |
| 硬预算 | 每次运行总搜索次数上限（pref `maxWebSearchesPerRun`，默认 6）。超了返回空结果 + `QUOTA EXHAUSTED` 强指令，模型必须作答。实测 9 次想要搜索的会话，provider 只会被真正调用 6 次。 |
| segment 空转守卫 | 文献检索场景：provider 重复 serve 同几篇 arXiv，按内容生成的指纹跨段撞车 → 第一个无进展 segment 就把整个 run判 `failed`，半截答案连同已搜到的来源一起丢掉。改为第一个无转不终止而是追加 `WRAP UP NOW` 指令续跑，第二次才以 `completed` 收手。 |

### 2. 豆包（Doubao）网页版桥接

上游 3.9.9 的 UI 里**没有豆包图标**：`WEBCHAT_TARGETS` 里有豆包、下拉里也确实列着 `www.doubao.com (Doubao)`，但那张卡片渲染出来是个**空白方块**（`iconModifier` 映射表只有chatgpt/deepseek/gemini 三项）。本项目补上这条完整的图标链路。

浏览器侧上游原版只覆盖 ChatGPT / DeepSeek / Gemini，`doubao_adapter.js` 是**全新文件**。

豆包 DOM 改版很频繁，所以适配器**不赌某一个固定 class**，而是每次调用时按候选优先级探测第一个真实挂载且可见的节点。解析不出来就返回空值而不是抛错——代价只是一次没抓到，不至于整个同步挂掉。

修掉的坑（都是实测踩出来的，不是猜的）：

- **豆包不给 per-message id**。按 `data-testid` 当身份会让**所有**用户气泡共用一个 key，于是第二个问题会返回第一个问题的答案。改为按同角色气泡序号生成 key，并在提交时快照 baseline、轮询和 emit 各查一次，拒收提交前就存在的旧回合。
- **key 会重复**。React 重新 mount 会让新回合的 key 撞上 baseline，于是 `findMatchingUserTurn` 拿不到候选、报`Chat never exposed a user turn`。位置回退原本写死成 DeepSeek 专属，豆包永远进不去，只能撞 30秒后的硬失败。
- **图片和链接整个丢失**。`htmlToMarkdown` 里 `case "img"` 原文写着"Images are not synced"，只返回 alt 文本。豆包和大多数 React 聊天界面一样会把 `src` 留成 1×1 占位图，真图在 `data-src`/`srcset`，所以要按可靠性依次探测。
- **不抢焦点**。不raise 窗口、不`tabs.update({active:true})`、不自动还原最小化窗口。最小化检测只记诊断，绝不阻断提交。

---

## 一键安装

```bash
git clone <this-repo>
cd <this-repo>
python install.py
```

`install.py` 做两件事：

1. 把打过补丁的 `.xpi` 装进 Zotero profile（自动探测 profile，备份原文件，写入 `extensions.json`）
2. 把浏览器扩展解压到 `browser-extension-installed/`，并打印需要粘贴到 `chrome://extensions` 的确切路径

装完还剩两步必须手动做（Chrome 的硬性限制）：

```
1) 启动 Zotero                        ← 必须运行，桥接依赖它
2) chrome://extensions → 开启开发者模式 → 加载已解压的扩展程序
   → 粘贴 install.py 打印的那个文件夹路径
3) Zotero: 设置 → llm-for-zotero
   - Web search provider → Free engines only   （否则走 Tavily，看不到搜索修复）
   - 任意 provider 卡片 → Auth mode → WebChat → Fetch Models → 选 www.doubao.com
4) 打开 https://www.doubao.com/chat/ 并保持该标签页打开
```

**先完全退出 Zotero 再跑安装**。运行中的 Zotero 会在退出时重写 profile，把改动覆盖掉。脚本检测到 Zotero 在跑会直接拒绝并提示，而不是强杀进程——强杀可能丢未保存的笔记。

选项：

```bash
python install.py --profile <path>   # 指定 Zotero profile
python install.py --xpi-only          # 只装插件，不动扩展
python install.py --ext-only# 只装扩展
```

---

## 从源码自己构建

发行版里已带 `dist/patched-llm-for-zotero-3.9.10.9.xpi`。想自己构建：

```bash
cd zotero-patches
python apply.py --xpi "/path/to/llm-for-zotero.xpi"
```

插件本体一般在：

- Windows：`%APPDATA%\Zotero\Zotero\Profiles\<profile>\extensions\zotero-llm@github.com.yilewang.xpi`
- macOS：`~/Library/Application Support/Zotero/Zotero/Profiles/<profile>/extensions/`
- Linux：`~/.zotero/zotero/<profile>/extensions/`

已实测通过的上游版本：**v3.9.9** 与 **v3.9.10**。`build_xpi.py` 会按上游版本号
派生补丁版号（3.9.10 → 3.9.10.9），不会把新版伪装成旧版。

上游更新后可能需要微调——每个脚本失败时都会明确报出找不到的锚点，而不是静默跳过。

需要 Node.js（用于 `node --check` 校验产物语法）。找不到时降级为警告而非中止；也可以 `SYNC_ZOTERO_NODE=/path/to/node` 显式指定。

---

## 目录结构

```
install.py                      一键安装器（跨平台、自动探测 profile）
run-tests.py                    一键跑全部离线测试
package.json                    测试依赖（linkedom，仅测试用）
dist/                           预构建的 .xpi（AGPL-3.0，见 NOTICE.md）
zotero-patches/                 改 Zotero 侧
  apply.py                        一键打包入口
  patches/
    patch_webaccess.py            免密钥多引擎搜索 + 三档切换 UI
    patch_search_quality.py       查询清洗 / 质量重排 / 正文富化
    patch_search_loop.py          单次运行账本 / 改写重复检测 / 硬预算
    patch_agent_segment.py        segment 空转守卫
    patch_doubao_target.py        向 WEBCHAT_TARGETS 注册豆包
    patch_doubao_ui.py            豆包图标三件套
    patch_doubao_dispatch.py      让 DOM 捕获型目标能走到 dispatch
    patch_doubao_composer.py      composerFound 只作参考信号
    patch_relay_debug.py          /debug 暴露扩展状态
    patch_target_switch.py        预检前先发布目标
    nodepath.py                   跨平台定位 node
  tests/
    bundle_source.js               定位/解包被补丁的 bundle
    test_search_loop.js            账本 / 重复检测 / 硬预算
    test_segment_stall.js          segment 空转守卫
browser-extension/              改浏览器侧（Apache-2.0，衍生自 sync-for-zotero）
  doubao_adapter.js                全新文件：豆包适配器
  gemini_adapter.js                Gemini 上传 file input 四级降级
  tests/                          扩展的离线断言（无需浏览器）
    verify_*.js                    129 项，读取真实 content_script.js
    legacy/                        需要 linkedom 的适配器测试 + 联网 e2e
```

---

## 测试

一键跑全部离线测试（不需要 Zotero、不需要浏览器、不联网）：

```bash
npm install     # 只为测试装 linkedom，装插件不需要
python run-tests.py
```

覆盖范围：

| 套件 | 项数 | 断言对象 |
|---|---|---|
| `zotero-patches/tests/test_search_loop.js` | 账本 / 重复检测 / 硬预算 | 真实 bundle 里的 `FWA_SEARCH_LEDGER` 块 |
| `zotero-patches/tests/test_segment_stall.js` | 空转守卫的两段行为 | 真实 bundle 里的 stall 块 |
| `browser-extension/tests/verify_doubao_focus_and_completion.js` | 焦点、回合身份、完成检测 | 真实 `content_script.js` |
| `browser-extension/tests/verify_doubao_userturn_binding.js` | 用户回合绑定与回退 | 真实 `content_script.js` |
| `browser-extension/tests/verify_doubao_media.js` | 图片与链接抽取 | 真实 `content_script.js` |
| `browser-extension/tests/legacy/test_doubao_adapter.js` | 豆包适配器探测与抽取 | 真实 `doubao_adapter.js` |
| `browser-extension/tests/legacy/test_gemini_upload.js` | Gemini 上传四级降级 | 真实 `gemini_adapter.js` |

`linkedom` 只用于最后两套适配器测试；`npm install` 装它只为跑测试，跟装插件无关。
测试从**真实源码**里extract 出函数再执行，
不做源码文本匹配——所以重构后不会假绿。补丁侧的测试会自己从
`dist/*.xpi` 里读出 bundle，也可以显式传路径：

```bash
node zotero-patches/tests/test_search_loop.js /path/to/llmforzotero.js
```

`browser-extension/tests/legacy/e2e_search_test.js` 会真的联网搜索，不在离线套件里，
需要时单独跑。

需要现场 DOM 样本时用 `browser-extension/tests/probe_doubao_media.js`，它只读地 dump
页面里的 `data-testid` 全集和图片候选载体。

---

## 已知限制

诚实说明边界：

1. **免费搜索依赖 HTML 抓取**。Bing 或 360 改版会让解析器失效，多引擎降级只能摊薄风险。实测 DuckDuckGo 国内不可达、Mojeek 返403、百度/搜狗返回跳转页，真正能用的只有 Bing 三域名 + 360。
2. **`maxResults` 上限是 10**，来自插件工具定义，与后端无关——买 Tavily 也拿不到第 11 条。
3. **WebChat 渠道没有 function calling，也不支持流式**。所以那套 `web_search` 在豆包模式下不生效，靠豆包自带联网。
4. **豆包 CDN 图片可能带防盗链**。笔记里存的是图片 URL，若Zotero 侧显示不出来，说明是防盗链而非本项目丢图。要「永远能看、能导出」得走插件的 `generatedImages` 存成附件那条路（需改中继协议）。
5. **补丁锚点只跟进到 v3.9.10**。更新的上游版本可能需要微调；`apply.py` 会在锚点失配时中止并报出具体是哪一个，不会产出一个半打补丁的包。

---

## 许可证

三份互不重叠，详见 [NOTICE.md](NOTICE.md)：

| 范围 | 许可 |
|---|---|
| `install.py`、`zotero-patches/**`（我们原创） | MIT，见 [LICENSE-MIT.txt](LICENSE-MIT.txt) |
| `dist/*.xpi`（llm-for-zotero 衍生品） | **AGPL-3.0** |
| `browser-extension/**`（sync-for-zotero 衍生品） | **Apache-2.0**，见其目录内 `LICENSE` 与 `CHANGES.md` |

GitHub 侧栏会把本仓库标为 **Other**（`NOASSERTION`）——这是对的：这里有三种不同许可，
GitHub 的自动识别只能选一个，写死任何一个都会误导用户。请以上表为准。

发布 `.xpi` 之所以合规，是因为**同一仓库里提供了完整的重建脚本**（AGPL 要求的"提供可构建源码"）。补丁脚本只保存字符串锚点和替换逻辑，运行时才去读用户本地已有的那份xpi，仓库内不含任何上游源码。
