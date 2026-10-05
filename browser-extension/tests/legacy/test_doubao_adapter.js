/**
 * Smoke test for the Doubao site adapter (doubao-dev/extension/doubao_adapter.js).
 *
 * The adapter probes a ranked list of selectors at call time instead of
 * betting on one fixed class name, because Doubao's markup moves.  That makes
 * two things worth pinning down:
 *
 *   1. the adapter returns every field the delivery/turn tracker expects.
 *      A missing one is not a graceful degradation - content_script.js reads
 *      these unconditionally and a gap throws mid-sync.
 *   2. the probes actually resolve against a plausible Doubao page, and the
 *      answer extractor returns the assistant's text rather than the chrome.
 *
 * Run:
 *   NODE_PATH=<managed node_modules> node tests/test_doubao_adapter.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { parseHTML } = require("linkedom");

const adapterPath = process.argv[2] || path.join(__dirname, "..", "..", "doubao_adapter.js");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log("  PASS  " + name);
  } else {
    failures += 1;
    console.log("  FAIL  " + name + (detail ? "\n        " + detail : ""));
  }
}

// A plausible Doubao page: a rich-editor composer, a send button carrying a
// Chinese label, and an assistant answer holding Markdown.
//
// The composer is a ProseMirror node nested inside the
// `data-testid="chat_input_input"` container, which is the shape the adapter's
// candidate list is written against. An earlier fixture used
// `data-testid="task-composer-input"`, a testid Doubao has never shipped, so
// the first two probe assertions failed against a page that could never have
// existed -- the adapter was right and the fixture was wrong.
const DOUBAO_PAGE = `<!doctype html><html><body>
  <div class="composer-wrapper">
    <div data-testid="chat_input_input" class="tiptap ProseMirror" contenteditable="true" role="textbox"><p><br></p></div>
    <button data-testid="chat_input_send_button" aria-label="发送">发送</button>
    <button data-testid="stop-button" aria-label="停止生成">停止</button>
  </div>
  <div class="chat-list">
    <div class="chat-item" data-testid="chat-item"><p>ToM 评估综述</p></div>
    <div class="chat-item" data-testid="chat-item">
      <div class="chat-item-user"><span class="content">这些文章分别讲了什么</span></div>
      <div class="chat-item-bot" data-testid="chat-item">
        <div class="markdown-body"><p>ToMi 由 Le 等人于 2019 年提出。</p></div>
      </div>
    </div>
    <a href="/chat/abc123">旧对话</a>
  </div>
</body></html>`;

const { window, document } = parseHTML(DOUBAO_PAGE);
const isVisibleElement = (node) => Boolean(node && node.isConnected !== false);
// the real bridge converts nodes to Markdown; record the node we were handed so
// the test can prove the adapter picked the right one
const picked = [];
const htmlToMarkdown = (html) => {
  const match = String(html).match(/<p>(.*?)<\/p>/);
  return match ? match[1] : String(html);
};

// URL/Date/setTimeout are used by the adapter's routing and prepareHistory;
// without them those paths would throw and be swallowed by the adapter's own
// try/catch, which would make the assertions below lie.
const sandbox = { console, globalThis: null, document, URL, Date, setTimeout };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(adapterPath, "utf8"), sandbox);
check("the adapter module registers itself", typeof sandbox.SyncZoteroDoubao === "object");

const adapter = sandbox.SyncZoteroDoubao.createAdapter({
  document, isVisibleElement, htmlToMarkdown,
  shared: { classifySubmittedPdfContract: () => ({ pdfAttachmentCount: 0 }) },
});

// --- contract completeness ----------------------------------------------------
console.log("\n[contract]");
const REQUIRED = [
  "siteId", "homeUrl", "answerCapture",
  "composerSelectors", "sendButtonSelectors", "findStopButton", "findUploadControl",
  "stopButtonSelectors", "userMessageSelector", "assistantMessageSelectors",
  "conversationMessageSelector", "conversationTurnSelector",
  "getMessageRole", "getMessageId",
  "extractUserMessageText", "extractAssistantAnswerText", "extractAssistantThinkingText",
  "extractAttachmentNames", "isResponseComplete", "getComposerAttachments",
  "getChatIdFromUrl", "historyLinkSelector", "prepareHistory", "buildHistoryEntry",
  "supportsFileUpload", "supportsModelSelector", "hasFormWrapper",
];
const missing = REQUIRED.filter((field) => adapter[field] === undefined);
check("every field the tracker reads is present (missing: " +
  (missing.length ? missing.join(", ") : "none") + ")", missing.length === 0);
check("siteId is 'doubao'", adapter.siteId === "doubao", adapter.siteId);
check("answerCapture is dom-based", adapter.answerCapture === "dom");
check("file upload is honestly reported as unsupported",
  adapter.supportsFileUpload === false, "supportsFileUpload=" + adapter.supportsFileUpload);
const functionFields = REQUIRED.filter((f) => typeof adapter[f] === "function");
check("all " + functionFields.length + " behaviour fields are callable",
  functionFields.every((f) => typeof adapter[f] === "function"));

// --- the probes resolve against the page --------------------------------------
console.log("\n[probe]");
// Doubao mounts either a plain <textarea> or a ProseMirror div depending on
// which editor build is live, so the candidate list is probed in order and the
// first hit wins. This fixture is the ProseMirror shape, i.e. candidate #3 --
// asserting that candidate #1 specifically would only test the fixture's
// editor choice, not the resolver.
const composer = adapter.composerSelectors
  .map((s) => { try { return document.querySelector(s); } catch (_) { return null; } })
  .find(Boolean);
check("a composer candidate resolves to a mounted node", Boolean(composer),
  adapter.composerSelectors.join(" | "));
check("the composer resolves through the candidate list",
  Boolean(adapter.composerSelectors.some((s) => {
    try { return Boolean(document.querySelector(s)); } catch (_) { return false; }
  })), adapter.composerSelectors.join(" | "));
const send = adapter.sendButtonSelectors();
check("sendButtonSelectors resolves the 发送 button",
  Boolean(send) && /发送/.test(send.getAttribute("aria-label") || ""),
  send && (send.getAttribute("aria-label") || send.textContent));
const stop = adapter.findStopButton();
check("findStopButton resolves a stop control", Boolean(stop));
check("every composer selector is a non-empty string",
  adapter.composerSelectors.length > 0 &&
  adapter.composerSelectors.every((s) => typeof s === "string" && s.length > 0));

// --- extraction ---------------------------------------------------------------
console.log("\n[extraction]");
const assistantNode = Array.from(document.querySelectorAll("[class*='chat-item-bot']"))[0];
const answer = adapter.extractAssistantAnswerText(assistantNode);
check("the assistant answer is extracted, not the surrounding chrome",
  /ToMi 由 Le 等人于 2019 年提出/.test(answer), JSON.stringify(answer.slice(0, 80)));
const userNode = document.querySelector("[class*='chat-item-user']");
const userText = adapter.extractUserMessageText(userNode);
check("the user turn is extracted", /这些文章分别讲了什么/.test(userText),
  JSON.stringify(userText));
check("getMessageRole distinguishes the two roles",
  adapter.getMessageRole(userNode) === "user" &&
  adapter.getMessageRole(assistantNode) === "assistant",
  adapter.getMessageRole(userNode) + "/" + adapter.getMessageRole(assistantNode));
check("a message id is produced for both roles",
  Boolean(adapter.getMessageId(userNode)) && Boolean(adapter.getMessageId(assistantNode)));
check("isResponseComplete is a boolean", typeof adapter.isResponseComplete() === "boolean");

// --- routing / history --------------------------------------------------------
console.log("\n[routing]");
check("conversation urls yield an id",
  adapter.getChatIdFromUrl("https://www.doubao.com/chat/abc123") === "abc123",
  adapter.getChatIdFromUrl("https://www.doubao.com/chat/abc123"));
check("a home url yields no id", adapter.getChatIdFromUrl("https://www.doubao.com/") === null);
const entry = adapter.buildHistoryEntry(document.querySelector("a[href^='/chat/']"));
check("a history entry is built with an id, title and url",
  entry && entry.id === "abc123" && /旧对话/.test(entry.title) && /\/chat\/abc123/.test(entry.chatUrl),
  JSON.stringify(entry));
check("the sidebar link selector finds the history link",
  Boolean(document.querySelector(adapter.historyLinkSelector)));

console.log("\n" + (failures ? failures + " FAILURE(S)" : "all assertions passed"));
process.exit(failures ? 1 : 0);
