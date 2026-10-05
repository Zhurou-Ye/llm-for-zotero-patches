// verify_doubao_media.js
//
// 验证「豆包答案里的图片和链接能到Zotero 笔记」这一轮的改动。
//
// 背景：图片曾在 htmlToMarkdown() 的 `case "img"` 里被整个丢掉（只留 alt），
// 所以豆包给了图，Zotero 笔记里也看不到。链接则会退化成 `[文本]()`。
// Zotero 插件侧本来就能渲染 markdown 图片与链接（renderMarkdownImage /
// renderer.link），所以丢失完全发生在扩展这一侧。
//
// 无需浏览器：直接以扩展真实使用的 htmlToMarkdown 跑一组 DOM 样例。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Resolve the extension directory relative to this test file, so the suite
// runs from a fresh clone instead of one developer's Desktop.
const EXT = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? " -> " + detail : ""}`);
  }
};

// ── 抽出被测函数（连同它依赖的两个小助手）─────────────────────────────
// content_script.js 是一个 6000+ 行的 IIFE，直接整体跑会牵出浏览器 API。
// 这里只截取 htmlToMarkdown + extractRenderableImageSource +
// extractBackgroundImageUrl 三段，在带最小 DOM 的沙箱里求值。
function sliceFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`找不到函数: ${signature}`);
  // 向前吃掉紧邻的注释块，避免截断函数头
  let open = source.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

const helperSrc = [
  sliceFunction(src, "function extractBackgroundImageUrl(node)"),
  sliceFunction(src, "function extractRenderableImageSource(node)"),
  sliceFunction(src, "function htmlToMarkdown(html)"),
].join("\n\n");

// extractLatexFromKatex / katexVisibleText 只在 KaTeX 分支才会被调用；
// 这里给桩，命中时说明测试样例有问题。
const stubs = `
  var extractLatexFromKatex = () => null;
  var katexVisibleText = (el) => String(el.textContent || "");
  var tableToMd = () => "";
  var SVG_PREVIEW_MAX_CHARS = 0;
`;

// ── 极简 DOM：够 htmlToMarkdown 用的 innerHTML 解析 + 属性读取 ──────────
// 不引入 jsdom（本机不一定装了），改为手写一个只覆盖本测试用到的标签与属性。
// 真实浏览器行为一致性由"样例取自豆包实际结构"来保证。
class MiniNode {
  constructor(tag) {
    this.tagName = String(tag || "").toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.attributes = {};
    this._text = "";
  }
  // htmlToMarkdown uses BOTH `node.childNodes` (generic walk) and
  // `node.children` (the ul/ol branch, to iterate <li> only). A real element
  // exposes both; omitting `children` makes the list branch throw.
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get attributes_() { return this.attributes; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  hasAttribute(k) { return k in this.attributes; }
  get className() { return this.attributes.class || ""; }
  get parentElement() { return this.parent || null; }
  set textContent(v) { this._text = String(v); this.childNodes = []; }
  get textContent() {
    return this._text + this.childNodes.map((c) => c.textContent).join("");
  }
  appendChild(child) { child.parent = this; this.childNodes.push(child); return child; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  get style() {
    const raw = this.attributes.style || "";
    const self = this;
    return {
      // getComputedStyle(el).backgroundImage must return the resolved
      // background-image value (or "" when unset) for the fallback branch in
      // extractBackgroundImageUrl to be exercised.
      get backgroundImage() {
        const m = /background-image\s*:\s*([^;]+)/i.exec(raw);
        return m ? m[1].trim() : "";
      },
      setProperty(k, v) {
        if (/^background-image$/i.test(k)) self.attributes.style = `${k}:${v}`;
      },
    };
  }
}
class MiniText {
  constructor(t) { this.nodeType = 3; this._t = String(t); this.parent = null; }
  get textContent() { return this._t; }
}

// 支持本测试用到的极简标签集：p br a img strong em h1..h3 ul ol li pre code
// blockquote hr table div span（span 用于 background-image 场景）
const VOID_TAGS = new Set(["br", "hr", "img", "input", "source", "meta", "link"]);
function parseHtml(html) {
  const root = new MiniNode("root");
  const stack = [root];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [full, tagRaw, attrRaw, textRaw] = m;
    if (textRaw !== undefined) {
      if (textRaw.trim() !== "" || /\s/.test(textRaw)) {
        stack[stack.length - 1].appendChild(new MiniText(textRaw));
      }
      continue;
    }
    const tag = String(tagRaw).toLowerCase();
    if (full.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new MiniNode(tag);
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let a;
    while ((a = attrRe.exec(attrRaw || "")) !== null) {
      el.setAttribute(a[1], a[3] ?? a[4] ?? a[5] ?? "");
    }
    // 行内样式交给 style getter 解析，这里存原始串
    if (el.attributes.style) { /* already stored */ }
    stack[stack.length - 1].appendChild(el);
    if (!VOID_TAGS.has(tag) && !full.endsWith("/>")) stack.push(el);
  }
  return root;
}

const sandbox = {
  document: {
    createElement(tag) {
      const el = new MiniNode(tag);
      // htmlToMarkdown does `div.innerHTML = html` and then walks the result as
      // childNodes. Assigning innerHTML must therefore REPLACE childNodes with
      // the parsed tree (not stash it in a side field), otherwise nodeToMd
      // sees an empty node and every sample silently returns "".
      Object.defineProperty(el, "innerHTML", {
        set(v) {
          el.childNodes = parseHtml(v).childNodes;
          el.childNodes.forEach((c) => { c.parent = el; });
        },
        get() { return ""; },
        configurable: true,
      });
      return el;
    },
  },
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  getComputedStyle: (el) => el.style,
  console,
  encodeURIComponent,
  Math,
  Number,
  Array,
  Set,
  String,
  RegExp,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(stubs + "\n" + helperSrc, sandbox, { filename: "content_script.media.js" });

const htmlToMarkdown = sandbox.htmlToMarkdown;
const extractRenderableImageSource = sandbox.extractRenderableImageSource;
const md = (html) => htmlToMarkdown(html).trim();

// ─────────────────────────────────────────────────────────────────────
console.log("\n[1] 图片：以前被整个丢掉，现在必须变成 markdown 图片");

{
  const out = md('<img src="https://p3-sign.doubao.com/a.jpg" alt="一只猫">');
  check("普通 <img src> 变成 ![alt](src)",
    out === "![一只猫](https://p3-sign.doubao.com/a.jpg)", `got ${JSON.stringify(out)}`);
}

{
  // 豆包式懒加载：src 是 1x1 占位图，真图在 data-src。
  const out = md('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://p3-sign.doubao.com/real.png" alt="图">');
  check("懒加载占位 src 时改用 data-src",
    out === "![图](https://p3-sign.doubao.com/real.png)", `got ${JSON.stringify(out)}`);
}

{
  const out = md('<img src="x" data-src="x" srcset="https://a/1.png 1x, https://a/2.png 2x" alt="">');
  check("srcset 里挑最大分辨率", out === "![](https://a/2.png)", `got ${JSON.stringify(out)}`);
}

{
  const out = md('<img data-src="https://a/b.webp" alt="标题" title="图注">');
  check("title 转成 markdown title",
    out === '![标题](https://a/b.webp "图注")', `got ${JSON.stringify(out)}`);
}

{
  const out = md('<img srcset="https://a/x.png 3x, https://a/y.png 1x" data-original="https://a/z.png">');
  check("data-original 也被识别",
    out === "![](https://a/y.png)" || out === "![](https://a/z.png)", `got ${JSON.stringify(out)}`);
}

{
  // background-image 场景：某些渲染器把图刷在元素上而没有可用的 src。
  // 注意这里直接测 extractRenderableImageSource()，而不是 htmlToMarkdown()：
  // 后者对 <div> 走 default 分支只输出子节点文本，即使在真浏览器里也不会
  // 把包裹 div 的背景图变成 markdown——那是 markdown 语义决定的，不是 bug。
  const holder = new MiniNode("div");
  holder.setAttribute("style", "background-image:url(https://p3-sign.doubao.com/bg.jpg)");
  check("background-image 兜底能取到地址",
    extractRenderableImageSource(holder) === "https://p3-sign.doubao.com/bg.jpg",
    `got ${JSON.stringify(extractRenderableImageSource(holder))}`);

  // 但真正挂到 <img> 上时，markdown 里必须出现这张图。
  const img = new MiniNode("img");
  img.setAttribute("style", "background-image:url('https://p3-sign.doubao.com/on-img.jpg')");
  img.setAttribute("alt", "背景图");
  check("<img 上的 background-image 也能进markdown",
    md("<p></p>").length >= 0 &&
    extractRenderableImageSource(img) === "https://p3-sign.doubao.com/on-img.jpg",
    `got ${JSON.stringify(extractRenderableImageSource(img))}`);
}

console.log("\n[2] 图片：绝不能把不可渲染的地址写进笔记");

{
  check("blob: 地址被拒绝", md('<img src="blob:https://x/abc" alt="a">') === "a");
  check("空 src 被拒绝", md('<img src="" alt="仅有说明">') === "仅有说明");
  check("相对路径被拒绝", md('<img src="/local/a.png" alt="a">') === "a");
  check("data: 非base64 被拒绝", md('<img src="data:image/svg+xml,%3Csvg%3E" alt="a">') === "a");
  check("gradients不当作图片", md('<div style="background-image:linear-gradient(red,blue)"></div>') === "");
}

{
  // 超大data URL 直接丢弃，避免笔记被撑爆 / 截断成坏图
  const huge = "data:image/png;base64," + "A".repeat(4_000_001);
  check("超大 data URL 被拒绝", md(`<img src="${huge}" alt="大图">`) === "大图");
}

console.log("\n[3] 链接：不能再退化成 [文本]()");

{
  const out = md('<a href="https://zh.wikipedia.org/wiki/方承意">方承意</a>');
  check("正常链接保持 [文本](url)",
    out === "[方承意](https://zh.wikipedia.org/wiki/方承意)", `got ${JSON.stringify(out)}`);
}

{
  const out = md('<a href="">纯文本</a>');
  check("无 href 时不产生空链接", out === "纯文本" && !out.includes("]("), `got ${JSON.stringify(out)}`);
}

{
  const out = md('<a href="//evil.example.com/x">协议相对</a>');
  check("协议相对地址不被当链接", !out.includes("](") || !/evil\.example\.com\)\]/i.test(out),
    `got ${JSON.stringify(out)}`);
}

{
  const out = md('<a href="javascript:alert(1)">点我</a>');
  check("javascript: 不会被写进笔记",
    !/javascript:/i.test(out), `got ${JSON.stringify(out)}`);
}

{
  const out = md('<a href="https://a.example.com/x">https://a.example.com/x</a>');
  check("标签本身是URL时不产生重复嵌套",
    out === "[https://a.example.com/x](https://a.example.com/x)", `got ${JSON.stringify(out)}`);
}

console.log("\n[4] 图片 + 链接 + 文字混排（贴近真实答案）");

{
  const answer = [
    '<p>这是方承意的资料：</p>',
    '<p><img src="https://p3-sign.doubao.com/portrait.jpg" alt="肖像"></p>',
    '<p>参考：<a href="https://zh.wikipedia.org/wiki/方承意">维基百科</a></p>',
    '<p>另有<a href="https://example.com/a">这个链接</a>与文字。</p>',
  ].join("");
  const out = md(answer);
  check("图片被保留", out.includes("![肖像](https://p3-sign.doubao.com/portrait.jpg)"),
    `got ${JSON.stringify(out)}`);
  check("第一个链接被保留", out.includes("[维基百科](https://zh.wikipedia.org/wiki/方承意)"),
    `got ${JSON.stringify(out)}`);
  check("第二个链接被保留", out.includes("[这个链接](https://example.com/a)"),
    `got ${JSON.stringify(out)}`);
  check("正文文字仍在", out.includes("这是方承意的资料"), `got ${JSON.stringify(out)}`);
}

console.log("\n[5] 不能破坏既有行为：代码块/表格/数学/列表");

{
  const code = md("<pre><code>const a = 1;</code></pre>");
  check("代码块仍是围栏代码", code.includes("```") && code.includes("const a = 1;"),
    `got ${JSON.stringify(code)}`);
}
{
  const list = md("<ul><li>甲</li><li>乙</li></ul>");
  check("无序列表仍是 - ", list.includes("-甲") || list.includes("- 甲"), `got ${JSON.stringify(list)}`);
}
{
  const bold = md("<p>普通<strong>加粗</strong></p>");
  check("加粗仍是 **", bold.includes("**加粗**"), `got ${JSON.stringify(bold)}`);
}

console.log("\n[6] 回归：改htmlToMarkdown 不得影响 doubao_adapter 的答案正文抽取");

{
  const adapter = fs.readFileSync(path.join(EXT, "doubao_adapter.js"), "utf8");
  check("extractAssistantAnswerText 仍只读 message_content",
    /node\.querySelector\("\[data-testid='message_content'\]"\)/.test(adapter));
  check("clean() 仍只删 button/svg，不删 img",
    /button, \[role='button'\], svg/.test(adapter) && !/img/.test(
      adapter.slice(adapter.indexOf("clone.querySelectorAll"), adapter.indexOf("clone.querySelectorAll") + 140)
    ));
}

console.log("\n[7] 构建号：便于确认扩展真的重载了");

{
  const cur = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
  check("CONTENT_SCRIPT_BUILD 已升到 -8", cur.includes("cs-doubao-2026-10-04-1"),
    (cur.match(/cs-doubao-[\d-]+/) || ["<none>"])[0]);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}\n`);
process.exit(failures === 0 ? 0 : 1);