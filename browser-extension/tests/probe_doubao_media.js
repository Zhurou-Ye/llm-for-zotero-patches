// probe_doubao_media.js
//
// 目的：搞清豆包答案里「图片」和「链接」在 DOM 里到底长什么样，
// 让我们写选择器时有真实依据，而不是猜。
// 上一轮的 bug（第二个问题拿到了第一个问题的答案）就是靠猜选择器猜出来的，
// 所以这一步不能省。
//
// 用法：
//   1) 先在 D:\chrome-dbg3（自有调试实例）里打开
//      https://www.doubao.com/chat/ 并保持登录。
//   2) 在那个页面里手动发一条**同时包含图片和链接**的问题，例如：
//        「给我一张猫的图片，并附上维基百科的链接」
//      等答案完全生成、图也显示出来之后再跑本脚本。
//   3) node probe_doubao_media.js
//
// 只读：不点击、不输入、不发送、不改页面状态。

const BASE = "http://127.0.0.1:9222";
const TARGET = "doubao.com";

function cdp(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const p = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && p.has(m.id)) {
        const { r, j } = p.get(m.id);
        p.delete(m.id);
        m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
      }
    };
    ws.onopen = () =>
      res({
        send(method, params = {}) {
          const i = id++;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((r, j) => p.set(i, { r, j }));
        },
        close: () => ws.close(),
      });
    ws.onerror = rej;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在页面里执行的探针。刻意沿用扩展实际使用的锚点
// （[data-testid='receive_message'] > [data-testid='message_content']），
// 这样看到的结构就是抽取逻辑真正会面对的结构。
const PROBE = `(() => {
  const attr = (el) => Array.from(el.attributes || [])
    .map(a => a.name + '="' + String(a.value).slice(0, 160) + '"').join(' ');
  const pick = (el, n = 220) => String(el.outerHTML || '').replace(/\\s+/g, ' ').slice(0, n);

  const turns = Array.from(document.querySelectorAll("[data-testid='receive_message']"));
  const last = turns[turns.length - 1] || null;
  const body = last
    ? (last.querySelector("[data-testid='message_content']") ||
       last.querySelector("[data-testid='message_text_content']") || last)
    : null;

  if (!body) {
    return JSON.stringify({
      ok: false,
      reason: "no assistant turn / no message_content",
      turnCount: turns.length,
      // 兜底：把页面上所有 data-testid 吐出来，便于确认改版后的新名字
      allTestIds: Array.from(new Set(
        Array.from(document.querySelectorAll('[data-testid]'))
          .map(e => e.getAttribute('data-testid'))
      )).sort().slice(0, 120),
    });
  }

  // ---- 图片：把所有可能承载图片的元素都列出来 ----
  const imgCandidates = Array.from(body.querySelectorAll(
    "img, picture source, [class*='image'], [class*='img'], [class*='photo'], " +
    "[class*='picture'], [class*='figure'], [class*='thumbnail'], [class*='poster'], " +
    "[style*='background-image'], [data-testid*='image'], [data-testid*='picture']"
  ));

  const images = imgCandidates.map((el) => {
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute("data-testid") || null,
      className: String(el.className || "").slice(0, 120) || null,
      // 关键：豆包常常把真实地址放在 data-* / srcset 上，src 只是占位图
      src: el.getAttribute("src"),
      dataSrc: el.getAttribute("data-src"),
      dataOriginal: el.getAttribute("data-original"),
      dataTestIdSrc: el.getAttribute("data-testid-src"),
      srcset: el.getAttribute("srcset"),
      styleAttr: el.getAttribute("style") ? String(el.getAttribute("style")).slice(0, 200) : null,
      computedBackgroundImage: cs && cs.backgroundImage && cs.backgroundImage !== "none"
        ? String(cs.backgroundImage).slice(0, 300) : null,
      currentSrc: el.currentSrc ? String(el.currentSrc).slice(0, 300) : null,
      naturalW: el.naturalWidth || null,
      naturalH: el.naturalHeight || null,
      alt: el.getAttribute("alt"),
      width: el.getBoundingClientRect ? Math.round(el.getBoundingClientRect().width) : null,
      height: el.getBoundingClientRect ? Math.round(el.getBoundingClientRect().height) : null,
      visible: !!(el.getBoundingClientRect && el.getBoundingClientRect().width > 0),
      html: pick(el),
    };
  });

  // ---- 链接 ----
  const links = Array.from(body.querySelectorAll("a[href], [role='link'], [class*='link']"))
    .slice(0, 40)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute("data-testid") || null,
      className: String(el.className || "").slice(0, 120) || null,
      href: el.getAttribute("href"),
      // 豆包常把真实地址放在 data-* 上，href 反而是占位/跳转变体
      dataHref: el.getAttribute("data-href"),
      dataUrl: el.getAttribute("data-url"),
      target: el.getAttribute("target"),
      rel: el.getAttribute("rel"),
      text: String(el.textContent || "").trim().slice(0, 120),
      visible: !!(el.getBoundingClientRect && el.getBoundingClientRect().width > 0),
      html: pick(el),
    }));

  // ---- 引用/来源卡片：豆包把参考链接放在这里，而不是普通 <a> ----
  const citeSelectors = [
    "[data-testid*='citation']", "[data-testid*='reference']",
    "[data-testid*='source']", "[class*='citation']", "[class*='reference']",
    "[class*='source-list']", "[data-testid*='search']", "[data-testid*='footnote']",
  ].join(",");
  const citations = Array.from(body.querySelectorAll(citeSelectors)).slice(0, 20)
    .map((el) => ({
      testId: el.getAttribute("data-testid") || null,
      className: String(el.className || "").slice(0, 120) || null,
      text: String(el.textContent || "").trim().slice(0, 200),
      linksInside: Array.from(el.querySelectorAll("a[href]")).map((a) => ({
        href: a.getAttribute("href"), text: String(a.textContent || "").trim().slice(0, 80),
      })).slice(0, 10),
      html: pick(el, 300),
    }));

  return JSON.stringify({
    ok: true,
    turnCount: turns.length,
    bodyFound: !!body,
    bodyTestId: body.getAttribute ? body.getAttribute("data-testid") : null,
    textPreview: String(body.textContent || "").trim().slice(0, 300),
    imageCount: images.length,
    images,
    linkCount: links.length,
    links,
    citationCount: citations.length,
    citations,
  });
})()`;

(async () => {
  let list = [];
  for (let i = 0; i < 20; i++) {
    try {
      list = await (await fetch(BASE + "/json/list")).json();
      if (list.length) break;
    } catch (_) { /* 实例还没起来 */ }
    await sleep(1000);
  }
  if (!list.length) {
    console.error(
      "连不上调试实例（" + BASE + "）。\n" +
      "请先启动 D:\\chrome-dbg3 并在里面打开豆包页面，然后重跑本脚本。",
    );
    process.exit(2);
  }

  const page = list.find(
    (t) => t.type === "page" && (t.url || "").includes(TARGET),
  );
  if (!page) {
    console.error("调试实例里没有打开豆包页面。请先在 D:\\chrome-dbg3 里打开 https://www.doubao.com/chat/");
    process.exit(2);
  }

  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send("Runtime.enable");
  const m = await c.send("Runtime.evaluate", {
    expression: PROBE,
    returnByValue: true,
    awaitPromise: true,
  });
  c.close();

  if (m.exceptionDetails) {
    console.error("页面内执行出错：", JSON.stringify(m.exceptionDetails).slice(0, 800));
    process.exit(1);
  }
  const raw = m.result && m.result.value;
  if (!raw) {
    console.error("探针没有返回内容。");
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error("返回不是合法 JSON：\n" + String(raw).slice(0, 800));
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
  if (!data.ok) {
    console.error("\n没找到助手回合正文。页面上的 data-testid 全量清单见上面的 allTestIds，" +
      "请据此更新 doubao_adapter.js 的选择器。");
    process.exit(1);
  }
  if (data.imageCount === 0) {
    console.error("\n这条答案里没有 <img>。请确认问题确实让豆包输出了图片。");
  }
  if (data.linkCount === 0) {
    console.error("\n这条答案里没有 <a href>。请确认问题确实让豆包输出了链接。");
  }
})();