// Offline verification of the two Doubao bridge fixes.
//
//  1. background.js  — Doubao must NOT be force-activated (that was yanking the
//     user's window to the front on every sync).
//  2. doubao_adapter.js — isResponseComplete() must scope its probe to the last
//     assistant turn. The old version searched the whole document for
//     `[class*='thinking']`, which permanently matches Doubao's "深度思考" mode
//     switch, so terminalEvidence was always false and the answer could never be
//     delivered back to Zotero.
//
// No browser is launched: the adapter is loaded against a hand-built DOM stub.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Resolve the extension directory relative to this test file, so the suite
// runs from a fresh clone instead of one developer's Desktop.
const EXT = path.resolve(__dirname, "..");
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? " -> " + detail : ""}`);
  }
};

// ── Minimal DOM stub ────────────────────────────────────────────────────────
class El {
  constructor(testid = "", className = "", opts = {}) {
    this.attrs = {};
    if (testid) this.attrs["data-testid"] = testid;
    if (className) this.className = className;
    Object.entries(opts.attrs || {}).forEach(([k, v]) => (this.attrs[k] = v));
    this.children = [];
    this.ownText = opts.text || "";
    this.visible = opts.visible !== false;
    this.parentElement = null;
  }
  // Recursive text, so a card's textContent includes its descendants' text --
  // the browser behaviour the attachment logic depends on.
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.ownText = v;
  }
  getAttribute(n) {
    return n in this.attrs ? this.attrs[n] : null;
  }
  contains(other) {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }
  querySelectorAll(sel) {
    const out = [];
    const match = (n) => sel.split(",").some((s) => matchesSimple(n, s.trim()));
    const walk = (n) => {
      n.children.forEach((c) => {
        if (match(c)) out.push(c);
        walk(c);
      });
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  closest() {
    return null;
  }
  cloneNode() {
    return this;
  }
}

// Supports "tag", "[a]", "[a='b']", "[a*='b']", ".cls", "tag.cls" — enough for
// every selector this adapter uses.
function matchesSimple(node, sel) {
  if (!sel) return false;
  const attrM = sel.match(/^\[([^\]=~*]+)([*^$~]?=)?"?([^"\]]*)"?\]$/);
  if (attrM) {
    // Groups: 1 = attribute name, 2 = operator, 3 = value. The value may keep
    // its surrounding quotes when the selector used single quotes, so strip
    // either quote style explicitly.
    const value = (attrM[3] || "").replace(/^['"]|['"]$/g, "");
    return attrMatch(node, attrM[1], attrM[2] || "", value);
  }
  function attrMatch(n, name, op = "", value = "") {
    let actual;
    if (name === "class") actual = n.className || "";
    else actual = n.getAttribute(name);
    if (actual == null) return false;
    if (op === "*=") return String(actual).includes(value);
    if (op === "^=") return String(actual).startsWith(value);
    if (op === "$=") return String(actual).endsWith(value);
    if (op === "=") return String(actual) === value;
    return true; // presence
  }
  if (sel.startsWith(".")) return (node.className || "").includes(sel.slice(1));
  if (sel.startsWith("#")) return node.getAttribute("id") === sel.slice(1);
  if (sel.startsWith("button")) return node.getAttribute("data-kind") === "button";
  if (sel === "form") return node.getAttribute("data-kind") === "form";
  return true; // tag name: our stub only builds the nodes we care about
}

function makeDoc(nodes) {
  const root = new El("__root__", "");
  root.children = nodes;
  root.querySelectorAll = (sel) => {
    const out = [];
    const match = (n) => sel.split(",").some((s) => matchesSimple(n, s.trim()));
    const walk = (n) => {
      n.children.forEach((c) => {
        if (match(c)) out.push(c);
        walk(c);
      });
    };
    walk(root);
    return out;
  };
  root.querySelector = (sel) => root.querySelectorAll(sel)[0] || null;
  return root;
}

const isVisibleElement = (el) => Boolean(el && el.visible);

// ── Load the adapter with the stub document ─────────────────────────────────
function loadAdapter(nodes) {
  const doc = makeDoc(nodes);
  const src = fs.readFileSync(path.join(EXT, "doubao_adapter.js"), "utf8");
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "doubao_adapter.js" });
  const factory = sandbox.SyncZoteroDoubao.createAdapter;
  return factory({
    document: doc,
    isVisibleElement,
    htmlToMarkdown: (html) => String(html).replace(/<[^>]+>/g, ""),
    shared: {},
  });
}

// ── Build a realistic Doubao conversation ───────────────────────────────────
function buildConversation({ streaming = false } = {}) {
  // "深度思考" mode switch — permanently present in the composer, class name
  // contains "thinking". This is what broke the old global probe.
  const deepThinkingToggle = new El("chat_input_deep_think", "deep-thinking-switch", {
    text: "深度思考",
  });

  const body = new El("message_content", "markdown-body", { text: "这是豆包的回答正文。" });
  const actionBar = new El("message_action_bar", "action-bar", { text: "复制 重新生成" });
  const stopBtn = new El("stop-button", "stop-btn", { text: "停止" });

  const turn = new El("receive_message", "message-block", {});
  turn.children = streaming ? [body, stopBtn] : [body, actionBar];

  return { docNodes: [deepThinkingToggle, turn], turn, body, actionBar, stopBtn };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[1] doubao_adapter.isResponseComplete — scoped to the assistant turn");

{
  const { docNodes, turn, stopBtn } = buildConversation({ streaming: true });
  const a = loadAdapter(docNodes);
  const during = a.isResponseComplete(null);
  check("returns false while the turn still shows a stop control", during === false,
    `got ${during}`);

  // Simulate generation finishing: stop control replaced by the action bar.
  turn.children = turn.children.filter((c) => c !== stopBtn);
  turn.children.push(new El("message_action_bar", "action-bar", { text: "复制" }));
  const after = a.isResponseComplete(null);
  check("returns true once the stop control is gone", after === true, `got ${after}`);
}

{
  // The regression that broke delivery: the "深度思考" switch alone must not
  // hold completion hostage.
  const { docNodes } = buildConversation({ streaming: false });
  const a = loadAdapter(docNodes);
  const r = a.isResponseComplete(null);
  check("ignores the permanent 深度思考 switch (old code returned false)", r === true,
    `got ${r}`);
}

{
  // No assistant turn at all -> nothing is streaming.
  const toggleOnly = new El("chat_input_deep_think", "deep-thinking-switch", { text: "深度思考" });
  const a = loadAdapter([toggleOnly]);
  const r = a.isResponseComplete(null);
  check("returns true when no assistant turn exists yet", r === true, `got ${r}`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[2] messageIdOf / getMessageId stay consistent");

{
  const { docNodes, turn } = buildConversation({ streaming: false });
  const a = loadAdapter(docNodes);
  const viaMethod = a.getMessageId(turn);
  const viaProbe = a.isResponseComplete(viaMethod);
  check("getMessageId returns a usable key", typeof viaMethod === "string" && viaMethod.length > 0,
    `got ${JSON.stringify(viaMethod)}`);
  // Key must resolve back to the same turn -> completion reflects that turn.
  check("passing that key back still resolves the turn", viaProbe === true, `got ${viaProbe}`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[3] background.js — Doubao is excluded from force-activation");

{
  const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const guarded = src.includes('if (siteConfig.siteId !== "doubao") {');
  check("ensureTabActive is guarded by a doubao exclusion", guarded);

  // ensureTabActive must appear exactly once, and only inside the doubao guard.
  const calls = src.match(/tab = await ensureTabActive\(tab\.id\);/g) || [];
  check("ensureTabActive is called exactly once", calls.length === 1, `found ${calls.length}`);
  const guardAt = src.indexOf('if (siteConfig.siteId !== "doubao") {');
  const callAt = src.indexOf("tab = await ensureTabActive(tab.id);");
  check("that call sits inside the doubao guard",
    guardAt !== -1 && callAt > guardAt && callAt - guardAt < 200,
    `guard@${guardAt} call@${callAt}`);

  // ensureTabActive itself must still not steal OS focus.
  const fn = src.slice(src.indexOf("async function ensureTabActive"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  check("ensureTabActive does not pass focused:true", !/focused\s*:/.test(body),
    /focused\s*:/.test(body) ? "found focused flag" : "");
  check("no windows.update focused:true anywhere",
    !/windows\.update\([^)]*focused\s*:\s*true/.test(src));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[4] regression guards");

{
  const src = fs.readFileSync(path.join(EXT, "doubao_adapter.js"), "utf8");
  // Anchor on the METHOD DEFINITION, not on any mention: comments above
  // messageIdOf discuss isResponseComplete(), and indexOf() would slice from
  // there and silently include unrelated helpers.
  const defAt = src.indexOf("isResponseComplete(assistantTurnKey");
  check("isResponseComplete method definition is locatable", defAt !== -1);
  const fn = src.slice(defAt);
  const body = fn.slice(0, fn.indexOf("\n        },"));
  check("no document-wide querySelector left in isResponseComplete",
    !/document\.querySelector/.test(body));
  check("no bare [class*='thinking'] probe", !/\[class\*=['"]thinking/.test(body));
  check("messageIdOf is hoisted out of the returned object",
    /const messageIdOf = \(node\)/.test(src));
  check("no free-variable getMessageId call inside the adapter",
    !/\(?[^.\w]getMessageId\(/.test(src.replace(/getMessageId: messageIdOf,/, "")));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[5] extractAttachmentNames — prompt text must never look like an attachment");

{
  // THE REGRESSION: a prompt-only user turn with no attachment card.
  // The old code fell back to scoping on the whole turn and pushed the prompt
  // text as an "attachment name", so classifySubmittedPdfContract saw
  // attachmentRequested=false with a non-empty attachment list and threw
  // "The prompt-only user turn unexpectedly contained a PDF attachment."
  const turn = new El("send_message", "user-turn", {});
  const textNode = new El("message_text_content", "text", {
    text: "请帮我总结这篇论文的结论，并说明它的局限。",
  });
  turn.children = [textNode];
  const a = loadAdapter([turn]);
  const names = a.extractAttachmentNames(turn);
  check("prompt-only turn reports NO attachments", Array.isArray(names) && names.length === 0,
    `got ${JSON.stringify(names)}`);
}

{
  // Same, but the prompt text itself mentions a .pdf filename. Still no card,
  // so still no attachment.
  const turn = new El("send_message", "user-turn", {});
  turn.children = [
    new El("message_text_content", "text", {
      text: "请比较 report.pdf 和 thesis.pdf 的差异",
    }),
  ];
  const a = loadAdapter([turn]);
  const names = a.extractAttachmentNames(turn);
  check("'.pdf' inside prompt text is not an attachment", names.length === 0,
    `got ${JSON.stringify(names)}`);
}

{
  // A REAL attachment: the grid wraps a per-file card with a name node.
  const turn = new El("send_message", "user-turn", {});
  const grid = new El("message_attachment_grid", "attachment-grid", {});
  const card = new El("message_nested_content", "file-card", {});
  const nameNode = new El("message_nested_content_file_name", "file-name", {
    text: "zotero-bridge-probe",
  });
  const subtitle = new El("message_nested_content_file_subtitle", "sub", {
    text: "PDF · 12 KB",
  });
  card.children = [nameNode, subtitle];
  grid.children = [card];
  turn.children = [grid];

  const a = loadAdapter([turn]);
  const names = a.extractAttachmentNames(turn);
  check("real PDF card yields exactly one name", names.length === 1, `got ${JSON.stringify(names)}`);
  check("PDF extension is restored on the extracted name",
    names[0] === "zotero-bridge-probe.pdf", `got ${JSON.stringify(names[0])}`);
}

{
  // Nested card de-duplication: the grid wraps the file card, so a raw query
  // returns both. Only the innermost should be reported, and the filename
  // must appear once.
  const turn = new El("send_message", "user-turn", {});
  const grid = new El("message_attachment_grid", "attachment-grid", {});
  const card = new El("file_card", "file-card", {});
  card.children = [
    new El("message_nested_content_file_name", "file-name", { text: "paper" }),
    new El("message_nested_content_file_subtitle", "sub", { text: "PDF · 3 MB" }),
  ];
  grid.children = [card];
  turn.children = [grid];
  const a = loadAdapter([turn]);
  const names = a.extractAttachmentNames(turn);
  check("nested grid/card is not double-counted", names.length === 1,
    `got ${JSON.stringify(names)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[6] classifySubmittedPdfContract agrees with the extractor");

{
  // Re-implement the shared contract decision closely enough to prove the two
  // now agree for the prompt-only case that used to throw.
  const sharedSrc = fs.readFileSync(path.join(EXT, "webchat_shared.js"), "utf8");
  const hasThrow = /The prompt-only user turn unexpectedly contained a PDF attachment\./.test(sharedSrc)
    || fs.readFileSync(path.join(EXT, "content_script.js"), "utf8")
      .includes("The prompt-only user turn unexpectedly contained a PDF attachment.");
  check("the prompt-only guard still exists in the pipeline", hasThrow);

  // With zero extracted names the contract is satisfied, so no throw.
  const turn = new El("send_message", "user-turn", {});
  turn.children = [new El("message_text_content", "t", { text: "普通提问" })];
  const a = loadAdapter([turn]);
  const attachments = a.extractAttachmentNames(turn);
  const wouldThrow = attachments.length > 0; // attachmentRequested === false
  check("prompt-only turn no longer trips the guard", wouldThrow === false,
    `attachments=${JSON.stringify(attachments)}`);
}

// ===========================================================================
console.log("\n[7] hard-truncated attachment names (Doubao CSS cut, no ellipsis)");

{
  const shared = require(path.join(EXT, "webchat_shared.js"));
  const expected =
    "Rahimirad 等 - 2026 - Bayesian Social Deduction with Graph-Informed Language Models.pdf";

  check("full name matches",
    shared.attachmentEvidenceMatchesFilename(expected, expected) === true);
  check("ellipsis form still matches",
    shared.attachmentEvidenceMatchesFilename(
      "Rahimirad 等 - 2026 - Bayesian Social Deduction with Graph-Informed…",
      expected,
    ) === true);
  // The real observed case: CSS cuts the card, no ellipsis character exists.
  check("hard-truncated name matches (the noisy-warn case)",
    shared.attachmentEvidenceMatchesFilename(
      "Rahimirad 等 - 2026 - Bayesian Social Deduction with Graph-Informed.pdf",
      expected,
    ) === true);
  check("an unrelated document does NOT match",
    shared.attachmentEvidenceMatchesFilename(
      "completely different document.pdf",
      expected,
    ) === false);
  check("a short name is never accepted on a short prefix",
    shared.attachmentEvidenceMatchesFilename("a.pdf", "a.pdf") === true &&
    shared.attachmentEvidenceMatchesFilename("a", "abcdefghij.pdf") === false);
}

// ===========================================================================
console.log("\n[8] the minimized-window check must ADVIS, never block");

// Third-round regression guard. The user kept hitting
// "The Doubao chat window is minimized" with a working Doubao window open, so
// the reading was wrong (stale state / re-homed tab). Because the check THREW,
// a false positive locked the user out of sending entirely. It is now advisory:
// the submit is always attempted, and a real failure names the likely cause.
{
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const cs = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");

  check("background pre-flight no longer throws on a minimized reading",
    !/if \(siteConfig\.siteId === "doubao"[\s\S]{0,200}throw new Error/.test(bg),
    "pre-flight still hard-blocks");
  check("background logs the suspicion instead of blocking",
    /still looks minimized[\s\S]{0,200}attempting the/.test(bg));

  // The submit path must not throw on a minimized reading. The only remaining
  // assignment of the reasonCode belongs to the *post-failure* error, so assert
  // that it is guarded by the failure-time flag rather than matching the bare
  // assignment (which would also match the legitimate one).
  check("content script no longer throws on a minimized reading at submit time",
    !/if \(minimized === true\)[\s\S]{0,200}throw/.test(cs),
    "submit path still throws on a minimized reading");
  check("the only chat_window_minimized reasonCode is the post-failure one",
    (cs.match(/reasonCode = "chat_window_minimized"/g) || []).length === 1 &&
    /if \(suspectMinimized\) noUserTurnError\.reasonCode = "chat_window_minimized"/.test(cs),
    "an unexpected throw site still assigns the reasonCode");
  check("content script records the reading as a flag instead",
    /chatWindowMinimizedAtSubmit = minimized === true/.test(cs));
  check("the flag is forwarded into the streaming call",
    /streamResponseSnapshots\([\s\S]{0,900}chatWindowMinimizedAtSubmit,/.test(cs));
  // Read the failure branch by brace balance rather than a guessed distance:
  // the flag it reads is declared far earlier in the function, so any
  // "within N chars" regex would be wrong by construction.
  {
    const anchor = cs.indexOf("never exposed a user turn");
    const start = cs.lastIndexOf("const suspectMinimized", anchor);
    const branch = cs.slice(start, anchor + 900);
    check("the real timeout error names the minimized window as a hypothesis",
      /submissionMeta\?\.chatWindowMinimizedAtSubmit === true/.test(branch) &&
      /most likely fix/.test(branch) &&
      /restoring the window \(it does not need focus\)/.test(branch) &&
      /reasonCode = "chat_window_minimized"/.test(branch),
      "timeout error does not carry the minimized hint");
    check("the hint only appears when the reading was actually minimized",
      /suspectMinimized\s*\?\s*"/.test(branch) && /:\s*""\)/.test(branch),
      "hint is unconditional");
  }
  check("the hint is phrased as a likely cause, not a fact",
    /most likely fix/.test(cs));

  // The user must be able to confirm which build is actually running.
  check("background reports its build id",
    /const BACKGROUND_BUILD = "bg-doubao-2026-10-03-6"/.test(bg) &&
    /buildId: BACKGROUND_BUILD/.test(bg));
  const popup = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
  check("popup surfaces the build id",
    /status\.buildId/.test(popup), "build id not shown in the popup");
}

// ===========================================================================
console.log("\n[9] tab selection must skip tabs in minimized windows");

// Second-round guard. The user saw "the window is minimized" while a working
// Doubao window was open: the pinned activeChatTabId (and getChatTab's
// `tabs[0]`) could both point at a leftover tab in a minimized window, so the
// bridge kept aiming at the hidden one.
{
  const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");

  check("a minimized-window cache exists",
    /minimizedWindowIds\s*=\s*new Set\(\)/.test(code));
  check("the cache is refreshed from chrome.windows.getAll",
    /async function refreshMinimizedWindowIds/.test(code) &&
    /chrome\.windows\.getAll/.test(code));
  check("only minimized windows are recorded",
    /state === "minimized"\)\s*minimizedWindowIds\.add/.test(code));

  // getChatTab must not blindly return tabs[0].
  const getChatTabBody = code.slice(code.indexOf("async function getChatTab"));
  const gct = getChatTabBody.slice(0, getChatTabBody.indexOf("\n}\n"));
  check("getChatTab filters out minimized-window tabs",
    /minimizedWindowIds\.has\(t\.windowId\)/.test(gct),
    "getChatTab still takes tabs[0] unconditionally");
  check("getChatTab falls back to a minimized tab only as a last resort",
    /if \(usable\.length > 0\)[\s\S]{0,200}return tabs\[0\]/.test(gct) ||
    /usable\.length > 0[\s\S]{0,240}tabs\[0\]/.test(gct));

  // The pinned tab must be abandoned when its window is minimized. Read the
  // real source (comments included) here — stripping them earlier shortened the
  // slice enough to cut the check off mid-function.
  const raw = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const flowStart = raw.indexOf("// ── Get the right chat tab");
  const flowSlice = raw.slice(flowStart, flowStart + 3000);
  check("the pipeline re-picks when the pinned tab is minimized",
    /minimizedWindowIds\.has\(existing\.windowId\)/.test(flowSlice) &&
    /activeChatTabId = null/.test(flowSlice),
    "pinned tab is reused regardless of window state");
  check("the pipeline refreshes the window cache before re-picking",
    /refreshMinimizedWindowIds\(true\)/.test(flowSlice),
    "stale cache could still report a visible window as minimized");

  // Health probing must also avoid minimized windows, or Zotero is told
  // "cannot find the chat composer" for a window the user can see.
  check("pickPreferredChatTab excludes minimized windows",
    /function pickPreferredChatTab[\s\S]{0,700}minimizedWindowIds\.has/.test(code));
  check("the health path refreshes the cache before picking",
    /async function refreshHealthSnapshot[\s\S]{0,300}refreshMinimizedWindowIds\(\)/.test(code));
}

// Behavioural proof: run the real pickPreferredChatTab against a stub
// minimized-window set. A regex can only show the code *mentions* the filter;
// this actually executes it.
{
  const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  // Extract the whole function by brace balancing so no assertion depends on a
  // guessed character count.
  const fnStart = src.indexOf("function pickPreferredChatTab");
  const braceStart = src.indexOf("{", fnStart);
  let depth = 0;
  let fnEnd = braceStart;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { fnEnd = i + 1; break; }
    }
  }
  const fnSource = src.slice(fnStart, fnEnd);
  check("pickPreferredChatTab was extracted whole",
    fnSource.includes("return") && fnSource.trimEnd().endsWith("}"),
    `extracted ${fnSource.length} chars`);

  const minimizedWindowIds = new Set([77]); // window 77 is minimized
  const activeChatTabId = 5; // pinned tab lives in the minimized window
  // A bare function declaration does not become a context global inside
  // runInNewContext, so hand it back explicitly.
  const pick = vm.runInNewContext(
    `var pickPreferredChatTab = ${fnSource}; pickPreferredChatTab;`,
    { minimizedWindowIds, activeChatTabId },
  );

  const tabs = [
    { id: 5, windowId: 77, active: false, status: "complete" }, // minimized!
    { id: 6, windowId: 12, active: false, status: "complete" },
    { id: 7, windowId: 12, active: true, status: "complete" },
  ];
  const chosen = pick(tabs);
  check("picks a visible-window tab even when the pinned one is minimized",
    chosen && chosen.id === 7, `chose id=${chosen && chosen.id}`);

  // With every window minimized there is no good choice left; the contract is
  // only "return a real candidate so the caller can report the blocker", not a
  // specific tab. Assert it stays inside the candidate set.
  const allMinimized = [
    { id: 5, windowId: 77, active: false, status: "complete" },
    { id: 6, windowId: 78, active: false, status: "complete" },
  ];
  const fallback = pick(allMinimized);
  check("still returns a real candidate when every window is minimized",
    fallback && allMinimized.some((t) => t.id === fallback.id),
    `chose id=${fallback && fallback.id}`);
}

// ===========================================================================
console.log("\n[9] window handling — the extension must NEVER touch window state");

// Regression guard for 2026-10-03. Two earlier designs were reverted:
//  1) restoring at submit time ("windows.update({state:'normal'}) never steals
//     focus") -- on Windows an un-minimize ALWAYS raises the window;
//  2) a pre-emptive restore ~1.5s after any minimize, which popped the browser
//     up on every ordinary minimize and made the user lose their place.
// The contract now: read the state, report the blocker, never change it.
{
  const code = fs.readFileSync(path.join(EXT, "background.js"), "utf8")
    .replace(/^\s*\/\/.*$/gm, ""); // strip line comments

  check("no chrome.windows.update call remains",
    !/chrome\.windows\.update\s*\(/.test(code),
    (code.match(/chrome\.windows\.update\s*\([^)]*\)/g) || []).join(" | "));

  check("no window-state restore helper remains",
    !/unminimizeWindow|schedulePreemptiveUnminimize|preemptiveUnminimizeTimer/.test(code));

  check("no onBoundsChanged listener remains",
    !/chrome\.windows\.onBoundsChanged/.test(code));

  check("no PREEMPTIVE_UNMINIMIZE_DELAY_MS constant remains",
    !/PREEMPTIVE_UNMINIMIZE_DELAY_MS/.test(code));

  // ensureChatTabVisible must be a pure wait, never a restore.
  const waitBody = code.slice(code.indexOf("async function ensureChatTabVisible"));
  const waitFn = waitBody.slice(0, waitBody.indexOf("\n}"));
  check("ensureChatTabVisible never restores the window",
    waitFn.length > 0 && !/windows\.update/.test(waitFn),
    waitFn.length === 0 ? "function not found" : "it restores the window");
  check("ensureChatTabVisible polls isChatWindowMinimized()",
    /isChatWindowMinimized/.test(waitFn));

  // The blocker must be reported to the user, not silently retried forever.
  check("a minimized window produces an actionable error",
    /minimized[\s\S]{0,240}Restore the Doubao window/.test(code),
    "no actionable minimized-window message");

  // chrome.windows.get needs no permission, and the old "windows" permission
  // was never a valid Chrome permission \— it made the whole extension fail
  // to load in 0.0.18.
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  check("manifest does NOT declare the invalid \'windows\' permission",
    Array.isArray(manifest.permissions) && !manifest.permissions.includes("windows"),
    JSON.stringify(manifest.permissions));
  check("manifest permissions are all real Chrome permissions",
    Array.isArray(manifest.permissions) &&
    manifest.permissions.every((p) =>
      ["tabs","storage","activeTab","scripting","alarms","webNavigation",
       "webRequest","notifications","contextMenus","downloads","identity",
       "sidePanel","offscreen","clipboardRead","clipboardWrite","idle",
       "topSites","history","bookmarks","cookies","management","nativeMessaging",
      ].includes(p)),
    JSON.stringify(manifest.permissions));
  check("extension version was bumped",
    manifest.version === "0.0.24", `got ${manifest.version}`);
}

{
  const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
  check("CONTENT_SCRIPT_BUILD bumped so stale tabs are detectable",
    src.includes("cs-doubao-2026-10-04-1"), "build id not updated");
  check("content script no longer promises to auto-restore",
    !/minimized[\s\S]{0,120}Restoring it and retrying/.test(src),
    "still claims it restores the window");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[9] Doubao turn identity — a new question must never inherit the previous answer");

{
  // THE REGRESSION (user report, 2026-10-03): ask "hi", then ask
  // "查一下方承意是谁". The second turn came back with "Hi 😊 What can I do for
  // you?" — the FIRST question's answer.
  //
  // Cause: Doubao ships no per-message id, and messageIdOf() fell back to
  // data-testid. Every user bubble is "send_message" and every model bubble is
  // "receive_message", so ALL user turns shared one key and ALL assistant turns
  // shared another. resolveBoundAssistantTurn() does
  // messages.findIndex(key === userTurnKey) and therefore landed on the FIRST
  // user turn, then returned the assistant turn after it — the old reply.
  const user1 = new El("send_message", "user-turn", {});
  user1.children = [new El("message_text_content", "text", { text: "hi" })];
  const ans1 = new El("receive_message", "message-block", {});
  ans1.children = [new El("message_content", "markdown-body", {
    text: "Hi 😊 What can I do for you?",
  })];
  const user2 = new El("send_message", "user-turn", {});
  user2.children = [new El("message_text_content", "text", { text: "查一下方承意是谁" })];
  const ans2 = new El("receive_message", "message-block", {});
  ans2.children = [new El("message_content", "markdown-body", { text: "方承意是…" })];

  const a = loadAdapter([user1, ans1, user2, ans2]);

  const k1 = a.getMessageId(user1);
  const k2 = a.getMessageId(user2);
  const ak1 = a.getMessageId(ans1);
  const ak2 = a.getMessageId(ans2);

  check("the two user turns get DIFFERENT keys",
    k1 !== k2, `both were ${k1}`);
  check("the two assistant turns get DIFFERENT keys",
    ak1 !== ak2, `both were ${ak1}`);

  // The exact lookup resolveBoundAssistantTurn/isResponseComplete perform.
  const firstMatch = [user1, user2].find((n) => a.getMessageId(n) === k2);
  check("findIndex(key === user2Key) lands on the SECOND user turn",
    firstMatch === user2, "still resolves to the first user turn");

  const firstAssistant = [ans1, ans2].find((n) => a.getMessageId(n) === ak2);
  check("isResponseComplete's key lookup lands on the SECOND assistant turn",
    firstAssistant === ans2, "still resolves to the first assistant turn");
}

{
  // Keys must be stable across re-renders of the SAME turn: Doubao re-mounts
  // nodes while streaming, and a key that changed on every tick would defeat
  // the whole binding. Same position => same key.
  const u = new El("send_message", "user-turn", {});
  u.children = [new El("message_text_content", "text", { text: "问题" })];
  const first = loadAdapter([u]).getMessageId(u);
  // The user turn's own text grows (streaming / hydration) -- key must not move.
  u.children[0].ownText = "问题（已补全）";
  const second = loadAdapter([u]).getMessageId(u);
  check("key is stable when the turn's own text changes", first === second,
    `${first} -> ${second}`);
}

{
  // The pipeline-level guard: an assistant turn that already existed at submit
  // time can never be delivered as this turn's answer.
  const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
  check("baseline assistant turn keys are captured at submit",
    /baselineAssistantKeys = new Set/.test(src));
  check("a pre-existing assistant turn is discarded while polling",
    /stale_assistant_turn_discarded/.test(src) &&
    /isPreexistingAssistantTurn\(assistantTurn\)/.test(src));
  check("the emit path re-checks that the answer is not a pre-existing turn",
    /isPreexistingAssistantTurn\(confirmedAssistantTurn\)/.test(src));
}

{
  const src = fs.readFileSync(path.join(EXT, "doubao_adapter.js"), "utf8");
  const body = src.slice(src.indexOf("const messageIdOf = (node)"));
  check("messageIdOf no longer derives identity from data-testid",
    !/getAttribute\?\.\("data-testid"\)/.test(body),
    "still keys on the shared testid");
  check("messageIdOf falls back to a per-role ordinal",
    /roleOrdinal/.test(body));
}

