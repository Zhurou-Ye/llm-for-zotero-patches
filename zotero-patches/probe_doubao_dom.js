/* eslint-env browser */
// ---------------------------------------------------------------------------
// llm-for-zotero Bridge — doubao.com DOM probe
//
// WHY THIS EXISTS
//   doubao.com is client-rendered, so the adapter's selectors cannot be derived
//   offline from its HTML. This probe runs inside the real page and reports what
//   is actually there, so the adapter can be pinned to concrete selectors
//   instead of guesses.
//
// HOW TO USE
//   1. Open https://www.doubao.com/chat/ and sign in.
//   2. Send at least one message, wait for the reply to finish rendering.
//   3. Open DevTools (F12) -> Console.
//   4. Paste this whole file and press Enter.
//   5. Copy everything printed after "=== DOUBAO PROBE JSON ===" and send it back.
//
// It never navigates, never clicks, and never mutates the page. Read-only.
// ---------------------------------------------------------------------------
(function doubaoProbe() {
  "use strict";

  var THEME = "color:#0F6E56;font-weight:bold";

  // Build the most stable selector we can for a node:
  // data-testid > id > stable-looking class trail > structural path.
  function selectorFor(node) {
    if (!node || node.nodeType !== 1) return null;
    var attrTests = [
      "data-testid",
      "data-test-id",
      "data-id",
      "data-key",
      "data-index",
      "data-message-id",
      "data-message-author-role",
      "data-role",
      "role",
    ];
    for (var i = 0; i < attrTests.length; i++) {
      var attr = attrTests[i];
      var value = node.getAttribute(attr);
      if (!value || value.length > 60) continue;
      try {
        if (
          document.querySelectorAll(
            "[" + attr + '="' + CSS.escape(value) + '"]'
          ).length === 1
        ) {
          return "[" + attr + '="' + value + '"]';
        }
      } catch (e) {
        /* ignore invalid escape */
      }
    }
    if (node.id && !/^\d|:/.test(node.id)) {
      try {
        if (document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
          return "#" + node.id;
        }
      } catch (e) {
        /* ignore */
      }
    }
    if (node.getAttribute("class")) {
      var classes = String(node.getAttribute("class"))
        .trim()
        .split(/\s+/)
        .filter(function (c) {
          // Skip hashed/unstable utility classes and pure layout helpers.
          return c.length > 3 && c.length < 44 && !/^css-|_scoped|\d{4,}/.test(c);
        })
        .slice(0, 3);
      for (var k = 0; k < classes.length; k++) {
        var candidate =
          node.localName.toLowerCase() + "." + classes.slice(0, k + 1).join(".");
        try {
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        } catch (e) {
          /* ignore */
        }
      }
    }
    return null;
  }

  function describe(element, label) {
    if (!element) return { [label]: null };
    return {
      [label]: {
        selector: selectorFor(element),
        tag: element.localName,
        classes: String(element.getAttribute("class") || "").slice(0, 220),
        attrs: Array.from(element.attributes)
          .filter(function (a) {
            return /^(id|role|data-[a-z-]{2,30}|contenteditable|aria-label|type)$/.test(a.name);
          })
          .map(function (a) {
            return a.name + "=" + String(a.value).slice(0, 60);
          })
          .slice(0, 14),
        visible: !!element.getClientRects().length,
        rect: (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(
          element.getBoundingClientRect()
        ),
        text: String(element.textContent || "").trim().slice(0, 120),
      },
    };
  }

  function findComposer() {
    var candidates = [
      "div[contenteditable='true']",
      "textarea",
      "[role='textbox']",
      "[contenteditable='true']",
    ];
    var best = null;
    candidates.forEach(function (sel) {
      Array.from(document.querySelectorAll(sel)).forEach(function (node) {
        var rect = node.getBoundingClientRect();
        // The composer sits low on the page and is reasonably wide.
        var score =
          (rect.width > 260 ? 2 : 0) +
          (rect.height > 30 && rect.height < 420 ? 2 : 0) +
          (rect.top > window.innerHeight * 0.4 ? 2 : 0);
        if (!best || score > best.score) best = { node: node, score: score, sel: sel };
      });
    });
    return best ? best.node : null;
  }

  function findSendButton(composer) {
    if (!composer) return null;
    var scope = [
      composer.closest("form"),
      composer.closest("div[class*='input']"),
      composer.closest("div[class*='composer']"),
      composer.parentElement,
      composer.parentElement && composer.parentElement.parentElement,
      document,
    ].filter(Boolean);
    for (var i = 0; i < scope.length; i++) {
      var buttons = Array.from(scope[i].querySelectorAll("button, div[role='button'], span[role='button']"));
      for (var j = 0; j < buttons.length; j++) {
        var b = buttons[j];
        var rect = b.getBoundingClientRect();
        if (rect.width < 14 || rect.height < 14) continue;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
        var label = (
          b.getAttribute("aria-label") +
          " " +
          (b.getAttribute("data-testid") || "") +
          " " +
          String(b.textContent || "").trim()
        ).toLowerCase();
        if (/发送|send|submit|enter/.test(label)) return b;
      }
    }
    return null;
  }

  // Guess the message list: the tallest scrollable container in the page.
  function findMessageContainer() {
    var best = null;
    Array.from(document.querySelectorAll("div, main, section")).forEach(function (node) {
      var style = window.getComputedStyle(node);
      var scrollable = /auto|scroll/.test(style.overflowY);
      var rect = node.getBoundingClientRect();
      if (!scrollable || rect.height < 200) return;
      var childCount = node.querySelectorAll("*").length;
      if (!best || childCount > best.childCount) {
        best = { node: node, childCount: childCount };
      }
    });
    return best ? best.node : null;
  }

  function run() {
    var composer = findComposer();
    var send = findSendButton(composer);
    var container = findMessageContainer();

    // Sample repeat-message structures inside the container.
    var textBlocks = [];
    if (container) {
      Array.from(container.querySelectorAll("div, p, article, li"))
        .slice(0, 400)
        .forEach(function (node) {
          var text = String(node.textContent || "").trim();
          if (text.length < 40 || text.length > 1200) return;
          // Keep only leaf-ish nodes so we do not report every wrapper.
          if (node.querySelectorAll("div, p, article").length > 3) return;
          var sel = selectorFor(node);
          if (sel) textBlocks.push({ selector: sel, len: text.length, text: text.slice(0, 90) });
        });
    }

    var report = Object.assign(
      {
        meta: {
          url: location.href,
          title: document.title,
          viewport: [window.innerWidth, window.innerHeight],
          lang: document.documentElement.lang,
          rootIds: Array.from(document.querySelectorAll("[id]"))
            .map(function (n) {
              return n.id;
            })
            .filter(function (id) {
              return /root|app|container|chat|main/i.test(id);
            })
            .slice(0, 10),
        },
      },
      describe(composer, "composer"),
      describe(send, "sendButton"),
      describe(container, "messageContainer"),
      {
        candidateAnswerBlocks: textBlocks.slice(0, 8),
        scrollHeight: container ? container.scrollHeight : null,
      }
    );

    console.log("%c=== DOUBAO PROBE JSON ===", THEME);
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
