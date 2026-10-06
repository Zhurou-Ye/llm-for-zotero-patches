# llm-for-zotero-patches

给 [`llm-for-zotero`](https://github.com/yilewang/llm-for-zotero) 这个 Zotero AI 插件做的补丁包，加两件它现在没有的东西：**免注册的联网搜索**，和**豆包（Doubao）网页版桥接**。

本文所有"原版如何"的描述都对着上游原版核实过：Zotero 侧是 v3.9.10 的 `content/scripts/llmforzotero.js`，浏览器侧是 `sync-for-zotero` 的 `main` 分支。核实结果写在 [下方"和上游的差异"](#问题一联网搜索要先注册第三方服务)。

> 非官方项目，不由原作者（Yile Wang）维护或背书。
> 上游插件：<https://github.com/yilewang/llm-for-zotero>（AGPL-3.0）
> 上游浏览器扩展：<https://github.com/yilewang/sync-for-zotero>（Apache-2.0）
> 完整归属声明见 [NOTICE.md](NOTICE.md)。

<!-- 截图位：放一张 Zotero 笔记里豆包回答的截图，一张 Zotero 设置里 provider 下拉的截图。
     小尺寸 GIF 更好，控制在 800px 宽以内。 -->

## 你会得到什么

| | 装到哪 | 解决什么 |
|---|---|---|
| **① Zotero 补丁** | Zotero 插件 `llm-for-zotero` | 联网搜索**不用注册任何账号** |
| **② 豆包桥接扩展**<br>`llm-for-zotero Bridge (Unofficial)` | Chrome / Edge | **从零新增**豆包（Doubao）支持：它的回答能自动写进 Zotero 笔记，含图片和链接 |

**两个是独立的。** 只想解决联网搜索 → 只装①。想用豆包 → 两个都装。

---

## 为什么需要它

### 问题一：联网搜索要先注册第三方服务

原版插件的联网搜索走 Tavily，你得先注册拿 key。本包替换掉这个 provider，接上一个自建的多引擎搜索器（Bing 三域名 → 360 → DuckDuckGo → Mojeek），任何一步返回结果就停。

**需要说清楚的一件事**：Tavily 免费套餐每月 1000 credits、不要信用卡、作者也不卖 key。所以这里省掉的是**注册这一步**，不是绕过付费——被替换的是一个本来就免费的服务。

换 provider 之后，就得让它真的搜得到东西。我们实测了免费引擎返回的摘要质量：

| provider | 平均每条摘要 | 10 条合计 |
|---|---|---|
| Tavily | 513 字符 | 5133 |
| 本包的免费引擎（替换前） | 58 字符 | 523 |

差了 10 倍——搜索引擎结果页的 meta description 对中文商业站基本就是营销话术。模型读到垃圾自然说"搜不到"，于是换个词再搜。抓到结果后并发抓正文、替换掉摘要，这是让免费引擎能用的关键一步。

换 provider 之后还补了几处让搜索真正收敛的东西：

| 症状 | 原因 | 修法 |
|---|---|---|
| 换个说法又搜一遍，结果完全一样 | 没有重复检测 | 每次搜索按词元集合记入账本；相似度 ≥ 0.6 判定为改写重复，直接在工具结果里告诉模型"和第 N 条重合 86%" |
| 反复搜索直到撞上轮数上限 | 上游只有轮数上限（`MAX_AGENT_ROUNDS`），没有次数预算 | 加硬预算（默认 6 次）。用完返回 `QUOTA EXHAUSTED` 强指令，模型必须作答 |

> **关于"检索卡住就不把答案丢掉"**
> 调试过程中我们撞到过一个问题：文献检索时，Agent 反复请求同一批 arXiv 论文，进度指纹跨段撞车，上游把第一个"无进展"判定当成硬失败，**已经搜到的来源和写到一半的答案一起丢弃**。
> 这是我们自己的补丁在调试时暴露出来的（上游 v3.9.10 的 `if (!newFingerprints.length && !settledNewTargets)` 分支确实会 `completeRun(finalText, "failed")`），顺手加了个守卫：第一次无进展不终止，改为让模型用现有材料收尾。**它不是这个包的主要卖点，只是让免费搜索在真实文献场景下不至于中途崩掉。** 如果你只关心"能不能搜"，可以忽略这一条。

### 问题二：上游根本没有豆包

这不是"原版有个坏掉的豆包入口"——**上游从头到尾就没有豆包**。对着 v3.9.10 的原始 bundle 核实：

- `WEBCHAT_TARGETS` 数组只有 3 项：`chatgpt` / `deepseek` / `gemini`
- 整个 bundle 里字符串 `doubao` 出现 **0 次**
- 浏览器扩展 `sync-for-zotero` 同样出现 **0 次**，只自带 chatgpt / deepseek / gemini 三个适配器

所以豆包这条链路——Zotero 侧的目标注册、设置界面图标、DOM 捕获型目标的分发路径，以及浏览器侧的 `doubao_adapter.js`——**全部是本包新写的**，不是修补。

豆包网页改版很频繁，所以适配器**不赌某一个固定 class** —— 每次调用按候选优先级探测第一个真实挂载且可见的节点；探测不到就返回空值而不是抛错，代价只是一次没抓到，不至于整个同步挂掉。

新写这条链路时踩出来并解决的问题：

- **第二个问题返回第一个问题的答案**。豆包不给消息唯一 id，**我们第一版适配器**用 `data-testid` 当身份，而豆包所有用户气泡共用这一个值，于是旧回合被当成新回合。改成按同角色气泡序号生成 key，并在提交时快照基线，轮询和回传各查一次，拒收提交前就存在的旧回合。
- **偶发报 `Chat never exposed a user turn`**。React 重新挂载会让新回合的 key 撞上基线。位置回退在上游是写死成 DeepSeek 专属的（`if (fallbackCandidates.length > 0 && deepseekRequestObserved)`），豆包进不去，只能撞 30 秒后的硬失败——所以把这个回退开放给所有站点。
- **图片和链接整个丢失**。上游 `htmlToMarkdown` 里 `case "img"` 原文写着 `// Images are not synced; keep the author-provided alt text.`，只返回 alt 文本。而豆包这类 React 界面会把 `src` 留成 1×1 占位图，真图在 `data-src` / `srcset`，所以要按可靠性依次探测。
- **不抢你的焦点**。不 raise 窗口、不 `tabs.update({active:true})`、不自动还原最小化的窗口。最小化检测只记诊断，绝不阻断提交。

---

## 安装

```bash
git clone https://github.com/Zhurou-Ye/llm-for-zotero-patches
cd llm-for-zotero-patches
python install.py
```

`install.py` 做两件事：把打过补丁的 `.xpi` 装进 Zotero profile（自动探测、备份原件、写入 `extensions.json`），并把浏览器扩展解压后打印需要粘贴的确切路径。

**装完还有三步要手动做**（Chrome 不允许程序代劳）：

```
1. 启动 Zotero                        ← 桥接依赖它
2. chrome://extensions → 开发者模式 → 加载已解压的扩展程序
   → 粘贴 install.py 打印的那个文件夹路径
3. Zotero: 设置 → llm-for-zotero
   - Web search provider → Free engines only   ← 不选这个看不到搜索修复
   - 任意 provider 卡片 → Auth mode → WebChat → Fetch Models → 选 www.doubao.com
4. 打开 https://www.doubao.com/chat/ 并保持该标签页打开
```

> **先完全退出 Zotero 再跑安装。** 运行中的 Zotero 退出时会重写 profile，把刚装的覆盖掉。脚本检测到 Zotero 在跑会直接拒绝并提示，不会强杀进程——强杀可能丢未保存的笔记。

可选参数：

```bash
python install.py --profile <path>   # 指定 Zotero profile
python install.py --xpi-only          # 只装插件，不动扩展
python install.py --ext-only          # 只装扩展
```

---

## 从源码构建

发行版已带 `dist/patched-llm-for-zotero-3.9.10.9.xpi`。想自己重建：

```bash
cd zotero-patches
python apply.py --xpi "/path/to/llm-for-zotero.xpi"
```

原版插件一般在：

- **Windows**：`%APPDATA%\Zotero\Zotero\Profiles\<profile>\extensions\zotero-llm@github.com.yilewang.xpi`
- **macOS**：`~/Library/Application Support/Zotero/Zotero/Profiles/<profile>/extensions/`
- **Linux**：`~/.zotero/zotero/<profile>/extensions/`

已实测通过的上游版本：**v3.9.9** 与 **v3.9.10**。`build_xpi.py` 按上游版本号派生补丁版号（3.9.10 → 3.9.10.9），不会把新版伪装成旧版，所以 Zotero 不会当成降级。

上游更新后补丁可能需要跟进——每个脚本失败时会明确报出**是哪一个锚点**没找到，不会静默跳过，更不会产出一个半打补丁的包。

<details>
<summary>构建环境要求</summary>

需要 Node.js 用于 `node --check` 校验产物语法。找不到时降级为警告而非中止；也可以用 `SYNC_ZOTERO_NODE=/path/to/node` 显式指定。
</details>

---

## 目录结构

```
install.py                      一键安装器（跨平台、自动探测 profile）
run-tests.py                    一键跑全部离线测试
package.json                    测试依赖（linkedom，仅测试用）
dist/                           预构建的 .xpi（AGPL-3.0，见 NOTICE.md）

zotero-patches/                 改 Zotero 插件侧
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
    test_readme_claims.js          本文的每个技术数字都对着bundle 核验

browser-extension/              改浏览器侧（Apache-2.0，衍生自 sync-for-zotero）
  doubao_adapter.js                全新文件：豆包适配器
  gemini_adapter.js                Gemini 上传 file input 四级降级
  tests/
    verify_*.js                    129 项断言，读取真实 content_script.js
    legacy/                        需要 linkedom 的适配器测试 + 联网 e2e
```

---

## 测试

```bash
npm install      # 只为测试装 linkedom，装插件不需要
python run-tests.py
```

不需要 Zotero、不需要浏览器、不联网。当前 **8 套 / 216 项断言全通过**。

| 套件 | 断言对象 |
|---|---|
| `zotero-patches/tests/test_search_loop.js` | 真实 bundle 里的 `FWA_SEARCH_LEDGER` 块 |
| `zotero-patches/tests/test_segment_stall.js` | 真实 bundle 里的 segment 空转块 |
| `zotero-patches/tests/test_readme_claims.js` | **本文的每个技术主张** + 产物里补丁是否真的在 |
| `browser-extension/tests/verify_doubao_focus_and_completion.js` | 真实 `content_script.js`（焦点、回合身份、完成检测） |
| `browser-extension/tests/verify_doubao_userturn_binding.js` | 真实 `content_script.js`（用户回合绑定与回退） |
| `browser-extension/tests/verify_doubao_media.js` | 真实 `content_script.js`（图片与链接抽取） |
| `browser-extension/tests/legacy/test_doubao_adapter.js` | 真实 `doubao_adapter.js` |
| `browser-extension/tests/legacy/test_gemini_upload.js` | 真实 `gemini_adapter.js` |

测试从**真实源码**里 extract 出函数再执行，不做源码文本匹配——所以重构后不会假绿。补丁侧的测试会自己从 `dist/*.xpi` 里读出 bundle，也可以显式传路径：

```bash
node zotero-patches/tests/test_search_loop.js /path/to/llmforzotero.js
```

> `test_readme_claims.js` 有一条明确的规则：**不许把只存在于打过补丁的 bundle 里的数字，写成对上游原版的描述**。这条规则是被三个假声明逼出来的（`MAX_AGENT_ROUNDS` 的 24/12、豆包的"空白卡片"、`data-testid` 身份），现在它会主动拒绝这三种写法。

<details>
<summary>联网测试与现场探针</summary>

`browser-extension/tests/legacy/e2e_search_test.js` 会真的联网搜索，不在离线套件里，需要时单独跑。

需要现场 DOM 样本时用 `browser-extension/tests/probe_doubao_media.js`，它只读地 dump 页面里的 `data-testid` 全集和图片候选载体。
</details>

---

## 已知限制

1. **免费搜索依赖 HTML 抓取**。Bing 或 360 改版会让解析器失效，多引擎降级只能摊薄风险。实测 DuckDuckGo 国内不可达、Mojeek 返 403、百度/搜狗返回跳转页，真正能用的只有 Bing 三域名 + 360。
2. **`maxResults` 上限是 10**，来自插件的工具定义，与后端无关——买 Tavily 也拿不到第 11 条。
3. **WebChat 渠道没有 function calling，也不支持流式**。所以那套 `web_search` 在豆包模式下不生效，靠豆包自带联网。
4. **豆包 CDN 图片可能带防盗链**。笔记里存的是图片 URL，如果 Zotero 侧显示不出来，说明是防盗链而不是本包丢图。要"永远能看、能导出"得走插件的 `generatedImages` 存成附件那条路（需要改中继协议）。
5. **补丁锚点只跟进到 v3.9.10**。更新的上游版本可能需要微调。

---

## 许可证

三份互不重叠，详见 [NOTICE.md](NOTICE.md)：

| 范围 | 许可 |
|---|---|
| `install.py`、`zotero-patches/**`（本项目原创） | MIT，见 [LICENSE-MIT.txt](LICENSE-MIT.txt) |
| `dist/*.xpi`（llm-for-zotero 衍生品） | **AGPL-3.0** |
| `browser-extension/**`（sync-for-zotero 衍生品） | **Apache-2.0**，见其目录内 `LICENSE` 与 `CHANGES.md` |

GitHub 侧栏会把本仓库标为 **Other**（`NOASSERTION`）——这是对的：这里有三种不同许可，GitHub 的自动识别只能选一个，写死任何一个都会误导用户。请以上表为准。

发布 `.xpi` 之所以合规，是因为**同一仓库里提供了完整的重建脚本**（AGPL 要求的"提供可构建源码"）。补丁脚本只保存字符串锚点和替换逻辑，运行时才去读用户本地已有的那份 xpi，仓库内不含任何上游源码。
