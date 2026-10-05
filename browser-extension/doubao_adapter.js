// SPDX-License-Identifier: Apache-2.0
//
// This file is a MODIFIED version of sync-for-zotero
// (https://github.com/yilewang/sync-for-zotero), Copyright Yile Wang,
// licensed under the Apache License, Version 2.0 (see ./LICENSE).
//
// Changes made by the llm-for-zotero-patches contributors:
//   - NEW FILE. Upstream ships no Doubao adapter at all.
//   - Candidate-first node resolution instead of a single hardcoded selector,
//     because Doubao changes its markup frequently.
//   - Message identity from each bubble's ordinal among its role, since Doubao
//     exposes no per-message id.
//   - Sends via a full pointer/mouse event sequence, which Doubao requires.
//
// Under Apache-2.0 section 4(b) this notice is retained in the source form of
// the derivative work. It is NOT relicensed; the file remains Apache-2.0.
//

// Doubao (www.doubao.com) site adapter for llm-for-zotero Bridge.
//
// Doubao's DOM is rewritten often, so instead of betting on one fixed class
// name this adapter probes a ranked list of candidates at call time and
// keeps the first one that is actually mounted and visible.  Anything that
// cannot be resolved degrades to an empty value rather than throwing, so an
// unknown markup change costs one missed capture instead of the whole sync.
//
// The contract mirrors gemini_adapter.js: the delivery/turn tracker in
// content_script.js owns sequencing, so this file only knows the site DOM.
(function (root) {
  root.SyncZoteroDoubao = {
    createAdapter({ document, isVisibleElement, htmlToMarkdown, shared }) {
      // Verified against the live doubao.com/chat page (2026-10):
      //   composer -> [data-testid="chat_input_input"] > div.tiptap.ProseMirror[contenteditable="true"]
      //   send     -> button[data-testid="chat_input_send_button"] inside div.send-btn-wrapper
      //   upload   -> button[data-testid="upload_file_button"]
      // The send button is only mounted once the composer is non-empty, so it
      // is expected to be missing during the pre-flight health check.
      const COMPOSER_CANDIDATES = [
        // Doubao ships two input implementations and swaps between them:
        //   a) rich editor  -> [data-testid="chat_input_input"] > div.tiptap.ProseMirror[contenteditable="true"]
        //   b) plain input  -> textarea[data-testid="chat_input_input"][placeholder="发消息..."]
        // When (b) is mounted the ProseMirror node stays in the DOM but is
        // visibility:hidden, so a contenteditable-only probe reports "no
        // composer" on a perfectly usable page.
        'textarea[data-testid="chat_input_input"]',
        'textarea[placeholder]',
        '[data-testid="chat_input_input"] [contenteditable="true"]',
        '[data-testid="chat_input"] [contenteditable="true"]',
        "div.tiptap.ProseMirror",
        "[class*='ProseMirror'][contenteditable='true']",
        '[data-testid="task-composer-input"]',
        '[data-testid="composer-input"]',
        "div[contenteditable='true'][role='textbox']",
        "div[contenteditable='true']",
        "textarea[placeholder][class*='input']",
        ".composer-input",
        "[class*='composer'] [contenteditable='true']",
        "[class*='composer'] textarea",
        "textarea",
      ];
      // WARNING: never probe a bare `[data-testid*="send"]` here. Doubao tags
      // the *user message bubble* with data-testid="send_message", so such a
      // selector resolves to the last message and the bridge clicks text
      // instead of submitting. Always anchor on the input container.
      const SEND_CANDIDATES = [
        '[data-testid="chat_input_send_button"]',
        '[data-testid="send-button"]',
        '[data-testid="button-send"]',
        '[class*="send-btn-wrapper"] button',
        '[class*="send-btn"] button',
        "button[aria-label*='发送']",
        "button[title*='发送']",
        "button[class*='send']",
      ];
      const SEND_SCOPE_SELECTORS = [
        "[data-testid='chat_input']",
        "[class*='send-btn-wrapper']",
        "form",
      ];
      // Deliberately NOT matching doubao's `chat_input_local_break_button`:
      // it is mounted as soon as the composer holds text, so treating it as a
      // "still generating" stop control would freeze completion detection.
      const STOP_CANDIDATES = [
        '[data-testid="stop-button"]',
        '[data-testid*="stop"]',
        "button[aria-label*='停止']",
        "button[class*='stop']",
      ];
      // Doubao tags the conversation bubbles with data-testid: the user turn
      // is `send_message`, the model turn is `message_content`, and the text
      // lives in `message_text_content`.
      const USER_CANDIDATES = [
        "[data-testid='send_message']",
        "[data-testid='user-message']",
        "[class*='user-message']",
        "[class*='chat-item-user']",
        "[class*='user-query']",
      ];
      const ASSISTANT_CANDIDATES = [
        "[data-testid='receive_message']",
        "[data-testid='message_content']",
        "[data-testid='answer-content']",
        "[data-testid='bot-message']",
        "[class*='answer-content']",
        "[class*='markdown-body']",
        "[class*='chat-item-bot']",
        "[class*='bot-message']",
      ];
      const TURN_CANDIDATES = [
        "[data-testid='union_message']",
        "[data-testid='message-block-container']",
        "[data-testid='send_message']",
        "[data-testid='receive_message']",
        "[data-testid='chat-item']",
        "[class*='chat-item']",
        "[class*='conversation-item']",
        "[class*='message-item']",
      ];

      const first = (selectors, scope = document) => {
        for (const selector of selectors) {
          try {
            const node = scope.querySelector(selector);
            if (node && isVisibleElement(node)) return node;
          } catch (_) { /* invalid or not mounted yet */ }
        }
        return null;
      };
      const all = (selectors, scope = document) => {
        const out = [];
        const seen = new Set();
        for (const selector of selectors) {
          try {
            for (const node of scope.querySelectorAll(selector)) {
              if (!seen.has(node) && isVisibleElement(node)) { seen.add(node); out.push(node); }
            }
          } catch (_) { /* ignore */ }
        }
        return out;
      };
      const last = (selectors) => {
        const found = all(selectors);
        return found.length ? found[found.length - 1] : null;
      };

      const messageRole = (node) => {
        const className = String(node?.className || "").toLowerCase();
        const testId = String(node?.getAttribute?.("data-testid") || "").toLowerCase();
        const text = `${className} ${testId}`;
        // Doubao names the two sides "send_message" (you) and
        // "receive_message" (the model) -- neither contains "user"/"bot", so
        // they must be matched explicitly before the generic heuristics.
        if (/send_message|user|query|human/.test(text)) return "user";
        if (/receive_message|bot|answer|assistant|model/.test(text)) return "assistant";
        return null;
      };

      // Hoisted out of the returned object so isResponseComplete() can reuse it
      // as a plain function. As an object method it would be a free variable
      // inside that closure and throw ReferenceError.
      // Doubao renders no per-message identifier: every user bubble is
      // data-testid="send_message" and every model bubble is
      // data-testid="receive_message". Deriving the key from the testid alone
      // therefore produced ONE key shared by every user turn and ONE shared by
      // every assistant turn. That silently broke turn binding in three places:
      //   1. transcript.messages.findIndex(key === userTurnKey) resolved to the
      //      FIRST user turn of the chat, so resolveBoundAssistantTurn() looked
      //      for the answer *after the very first question* and happily returned
      //      the previous reply;
      //   2. isResponseComplete(key) found the FIRST assistant turn, which was
      //      always already finished, so the tracker declared "done" instantly;
      //   3. conversationMessagesAfterBaseline() saw every current key inside
      //      the baseline and had to fall back to raw position slicing.
      // The symptom was a fresh question being answered with the PREVIOUS
      // question's reply (and Doubao itself looking like it "repeated itself").
      //
      // Fix: prefer a real per-message attribute if Doubao ever ships one, and
      // otherwise key on the turn's ordinal position among the visible bubbles
      // of the same role. Position is used rather than DOM-node identity on
      // purpose: the conversation is append-only, so earlier ordinals never
      // change while a new turn streams, and the key survives React re-mounting
      // the node mid-answer. Falling back to a per-node token would silently
      // change identity on every re-mount and re-open the same class of bug.
      const ROLE_ROOT_SELECTORS = {
        user: "[data-testid='send_message']",
        assistant: "[data-testid='receive_message']",
      };
      const roleOrdinal = (node, role) => {
        const selector = ROLE_ROOT_SELECTORS[role];
        if (!selector) return -1;
        try {
          const nodes = document.querySelectorAll(selector);
          for (let index = 0; index < nodes.length; index += 1) {
            if (nodes[index] === node) return index;
          }
        } catch (_) { /* fall through to the node token */ }
        return -1;
      };
      // Last-resort identity for bubbles that are not the canonical root (for
      // example a stray `[data-testid="message_content"]` fragment).
      const nodeTokens = new WeakMap();
      let nodeTokenSerial = 0;
      const nodeToken = (node) => {
        if (!node || typeof node !== "object") return null;
        let token = nodeTokens.get(node);
        if (!token) {
          nodeTokenSerial += 1;
          token = `n${nodeTokenSerial}`;
          nodeTokens.set(node, token);
        }
        return token;
      };
      const messageIdOf = (node) => {
        const role = messageRole(node);
        if (!role) return null;
        const explicit =
          node.getAttribute?.("data-message-id") ||
          node.getAttribute?.("data-conversation-message-id") ||
          node.getAttribute?.("data-msg-id") ||
          null;
        if (explicit) return `${explicit}:${role}`;
        const ordinal = roleOrdinal(node, role);
        if (ordinal >= 0) return `doubao-${role}-${ordinal}`;
        const token = nodeToken(node);
        return token ? `doubao-${role}-node-${token}` : null;
      };

      const clean = (node) => {
        const clone = node.cloneNode(true);
        // Doubao streams citations and toolbar widgets inside the answer; keep
        // the links (they are the useful part) and drop the rest of the chrome.
        clone.querySelectorAll("button, [role='button'], svg, [aria-hidden='true']").forEach((el) => el.remove());
        return clone;
      };

      const composer = () => first(COMPOSER_CANDIDATES);
      // Keep the send-button search inside the input area: a document-wide
      // search picks up the user message bubble (data-testid="send_message").
      const sendScope = () => {
        const node = composer();
        if (!node) return document;
        for (const selector of SEND_SCOPE_SELECTORS) {
          const scope = node.closest(selector);
          if (scope) return scope;
        }
        return document;
      };
      const sendButton = () => {
        const scope = sendScope();
        const scoped = scope === document ? null : first(SEND_CANDIDATES, scope);
        if (scoped) return scoped;
        // Last resort: the canonical send control anywhere on the page.
        return first(['[data-testid="chat_input_send_button"]'], document);
      };

      return {
        siteId: "doubao",
        homeUrl: "https://www.doubao.com/chat/",
        answerCapture: "dom",
        composerSelectors: COMPOSER_CANDIDATES,
        sendButtonSelectors: () => sendButton(),
        findStopButton: () => first(STOP_CANDIDATES, composer()?.closest("[class*='composer'], form") || document),
        findUploadControl: () => {
          const root2 = composer()?.closest("[data-testid='chat_input']") || composer()?.parentElement || null;
          return first(["[data-testid='upload_file_button']", "[class*='upload'] button", "[aria-label*='上传']", "button[class*='plus']", "button[class*='attach']"], root2 || document);
        },
        // Doubao exposes a real <input type="file"> in the composer. Dropping a
        // synthetic DragEvent on it is unreliable (and left the pipeline
        // waiting on an attachment that never appeared), so set the input's
        // files directly the way Gemini's adapter does.
        async uploadFile(file, {
          wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now = () => Date.now(),
          timeoutMs = 30_000,
        } = {}) {
          const startedAt = now();
          // Doubao keeps its <input type="file"> permanently hidden (it is the
          // invisible backend of the plus/attach button), so the visibility
          // filtered `first()` helper never sees it. Walk the tree --
          // including shadow roots -- and rank the result ourselves.
          const rank = (hits) => {
            if (!hits.length) return null;
            // Prefer the input that belongs to the active composer.
            const inputRoot =
              composer()?.closest("[data-testid='chat_input']") ||
              composer()?.parentElement;
            return (
              (inputRoot && hits.find((el) => inputRoot.contains(el))) ||
              hits.find((el) => el.getAttribute("data-testid") === "upload-file-input") ||
              hits.find((el) => String(el.getAttribute("accept") || "").includes("pdf")) ||
              hits[0]
            );
          };
          const shallowFind = () =>
            rank([
              ...document.querySelectorAll(
                "input[type='file'], [data-testid='upload-file-input']",
              ),
            ]);
          // Only pay for the shadow-DOM walk when the plain query comes up
          // empty -- it runs on every poll tick.
          const findInput = () => {
            const shallow = shallowFind();
            if (shallow) return shallow;
            const hits = [];
            const walk = (node) => {
              try {
                for (const el of node.querySelectorAll("*")) {
                  if (el.shadowRoot) {
                    try {
                      hits.push(...el.shadowRoot.querySelectorAll(
                        "input[type='file'], [data-testid='upload-file-input']",
                      ));
                    } catch (_) { /* cross-origin shadow, ignore */ }
                    walk(el.shadowRoot);
                  }
                }
              } catch (_) { /* ignore */ }
            };
            walk(document);
            return rank(hits);
          };
          let input = findInput();
          if (!input) {
            // Doubao creates the <input type="file"> lazily ~2s AFTER the
            // upload button is clicked (measured 2026-10-02), so keep pressing
            // the button and polling instead of giving up after one click.
            const mountDeadline = startedAt + 12_000;
            let lastClickAt = 0;
            while (!input && now() < mountDeadline) {
              if (now() - lastClickAt >= 1_500) {
                const button = first(
                  [
                    "[data-testid='upload_file_button']",
                    "[data-testid*='upload']",
                    "button[aria-label*='上传']",
                  ],
                  document,
                );
                if (button) {
                  try { button.click(); } catch (_) { /* ignore */ }
                  lastClickAt = now();
                }
              }
              await wait(200);
              input = findInput();
            }
          }
          if (!input) {
            throw new Error("Doubao upload file input was not found.");
          }
          const transfer = new DataTransfer();
          transfer.items.add(file);
          try {
            input.files = transfer.files;
          } catch (err) {
            throw new Error(
              `Doubao rejected the injected file: ${err?.message || String(err)}`,
            );
          }
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new Event("input", { bubbles: true }));

          let evidence = null;
          const deadline = startedAt + timeoutMs;
          while (now() < deadline) {
            const holder =
              composer()?.closest("[data-testid='chat_input']") || document.body;
            if (String(holder.innerText || "").includes(file.name)) {
              evidence = file.name;
              break;
            }
            await wait(150);
          }
          return {
            method: "file_input",
            filenameConfirmed: Boolean(evidence),
            readyConfirmed: Boolean(evidence),
            evidence,
            totalElapsedMs: now() - startedAt,
          };
        },
        stopButtonSelectors: STOP_CANDIDATES,
        userMessageSelector: USER_CANDIDATES[0],
        assistantMessageSelectors: ASSISTANT_CANDIDATES,
        conversationMessageSelector: USER_CANDIDATES.concat(ASSISTANT_CANDIDATES).join(", "),
        conversationTurnSelector: TURN_CANDIDATES[0],
        getMessageRole: messageRole,
        getMessageId: messageIdOf,
        extractUserMessageText(node) {
          const inner =
            node?.querySelector("[data-testid='message_text_content']") ||
            node?.querySelector("[class*='content'], [class*='text']") ||
            node;
          return htmlToMarkdown(clean(inner || document.body).innerHTML).trim();
        },
        extractAssistantAnswerText(node) {
          if (!node) return "";
          // The answer body lives in `[data-testid="message_content"]` inside
          // the turn. Verified structure (2026-10-03):
          //   [data-testid="receive_message"]           <- the whole turn
          //     > div.flex.flex-col
          //       > [data-testid="message_content"]     <- the actual answer
          // Running innerText on the turn itself also swallows the follow-up
          // suggestion chips (`suggest_message_list`) and the sidebar promo
          // ("下载豆包电脑版…"), which both live under the same turn node — that
          // polluted the delivered answer. Anchor on the body, then fall back
          // to the generic markdown/prose candidates only if it is absent.
          const body =
            node.querySelector("[data-testid='message_content']") ||
            node.querySelector("[data-testid='message_text_content']");
          const holder =
            body ||
            node.querySelector("[class*='markdown'], [class*='answer-content'], [class*='content']") ||
            node;
          const clone = clean(holder);
          // Inside the body, still drop the suggestion chips / action bar /
          // citation toolbar so only prose is returned.
          clone
            .querySelectorAll(
              "[data-testid='suggest_message_list'], [data-testid='suggest_message_item'], [data-testid='message_action_bar'], [data-testid='after_message_download_desktop_button']",
            )
            .forEach((el) => el.remove());
          return htmlToMarkdown(clone.innerHTML).trim();
        },
        extractAssistantThinkingText: () => "",
        // A submitted file shows up inside the *user turn* as a card:
        //   [data-testid="message_attachment_grid"]
        //     [data-testid="message_nested_content_file_name"]      -> name
        //     [data-testid="message_nested_content_file_subtitle"]  -> "PDF · 12 KB"
        // Returning [] here made every PDF send fail its post-submit contract
        // check ("The submitted user turn did not contain the requested PDF").
        extractAttachmentNames(node) {
          if (!node) return [];
          const out = [];
          // NOTE: `clean()` above takes a DOM node (it clones it) -- strings
          // must go through a plain text normaliser instead.
          const normText = (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim();
          const pushUnique = (value) => {
            const text = normText(value);
            if (!text || text.length < 2) return;
            if (!out.includes(text)) out.push(text);
          };
          const cardSelectors = [
            "[data-testid='message_attachment_grid']",
            "[data-testid*='attachment']",
            "[data-testid*='file_card']",
            "[class*='attachment']",
            "[class*='file-card']",
            "[class*='file_card']",
          ];
          const nameSelectors = [
            "[data-testid='message_nested_content_file_name']",
            "[data-testid*='file_name']",
            "[data-testid*='filename']",
            "[class*='file_name']",
            "[class*='file-name']",
            "[class*='filename']",
          ];
          // Doubao nests these: `[data-testid="message_attachment_grid"]` wraps
          // per-file cards, so a plain query returns both and each file would
          // be collected twice. Keep only the innermost cards (those that do
          // not themselves contain another card).
          const allCards = Array.from(node.querySelectorAll(cardSelectors.join(", ")));
          const cards = allCards.filter(
            (card) => !allCards.some((other) => other !== card && card.contains(other)),
          );
          // CRITICAL: never fall back to `node` itself as a scope.
          // When a turn carries no attachment card at all, scoping to the whole
          // user turn made the last-resort branch below push the PROMPT TEXT
          // itself as an "attachment name", so every prompt-only sync failed
          // with "The prompt-only user turn unexpectedly contained a PDF
          // attachment." If there is no attachment card there is no attachment.
          for (const scope of cards) {
            const cardText = normText(scope.textContent || "");
            if (!cardText) continue;
            const nameNodes = Array.from(scope.querySelectorAll(nameSelectors.join(", ")));
            for (const el of nameNodes) {
              let name = normText(
                el.getAttribute?.("title") ||
                  el.getAttribute?.("aria-label") ||
                  el.textContent ||
                  "",
              );
              if (!name) continue;
              // Doubao often drops the extension in the rendered card; the
              // contract check matches on the full "...pdf" name, so restore it
              // when the card itself declares the file is a PDF.
              const isPdf = /pdf/i.test(cardText) || /\.pdf$/i.test(name);
              if (isPdf && !/\.[a-z0-9]{1,6}$/i.test(name)) name = `${name}.pdf`;
              pushUnique(name);
            }
            // A card exists but exposes no dedicated name node (markup changed
            // again). Only trust a real ".pdf" token here -- the card is already
            // known to be an attachment, so this cannot pick up prompt text.
            const pdfInText = cardText.match(/[^\s/\\]{1,180}\.pdf/);
            if (pdfInText) {
              pushUnique(pdfInText[0]);
            }
          }
          return out;
        },
        // Completion detection for Doubao.
        //
        // The previous implementation searched the WHOLE document for
        // `[class*='thinking'], [class*='generating'], [class*='streaming']`.
        // That is fatally wrong for Doubao: the composer permanently mounts a
        // "深度思考" (deep-thinking) mode switch whose class name contains
        // "thinking", so the probe matched forever and isResponseComplete()
        // returned false on every single poll. terminalEvidence is a hard
        // requirement for BOTH the DOM completion path and the SSE fast path
        // in content_script.js, so the turn could never be emitted — the answer
        // rendered in the page but was never delivered back to Zotero.
        //
        // The fix scopes the probe to the last assistant turn and drops the
        // bare "thinking" class, keeping only markers that genuinely appear
        // while that specific turn is still being written.
        isResponseComplete(assistantTurnKey = null) {
          const turns = all(["[data-testid='receive_message']"]);
          const turn = assistantTurnKey
            ? (turns.find((node) => messageIdOf(node) === assistantTurnKey) ||
              turns[turns.length - 1] ||
              null)
            : (turns[turns.length - 1] || null);
          // No assistant turn rendered yet: nothing is streaming.
          if (!turn) return true;

          // Positive in-progress signals, scoped to this turn only.
          const inProgress = turn.querySelector(
            "[data-testid*='stop'], [data-testid*='generating'], [data-testid*='streaming'], " +
            "[class*='is-generating'], [class*='is-streaming'], [class*='generating-text'], " +
            "[class*='typing'], [class*='loading-']",
          );
          if (inProgress && isVisibleElement(inProgress)) return false;

          // Doubao renders a "停止" control while it writes. It is mounted in
          // the turn's own action row, not the composer's break button.
          const stopControl = turn.querySelector(
            "button[aria-label*='停止'], button[title*='停止']",
          );
          if (stopControl && isVisibleElement(stopControl)) return false;

          // Otherwise the turn is finished. The action bar (copy / regenerate /
          // like, `[data-testid="message_action_bar"]`) is mounted only after
          // generation ends and is the explicit positive signal for that, but
          // its absence is not treated as "still running": a missing bar must
          // not re-introduce the stall this fix removes. The caller's quiet
          // window plus the stable-snapshot re-read guard against delivering a
          // half-written answer.
          return true;
        },
        getComposerAttachments: () => [],
        getChatIdFromUrl(url) {
          try {
            const parsed = new URL(url, "https://www.doubao.com/");
            const match = parsed.pathname.match(/^\/chat\/([^/?#]+)/);
            return match ? match[1] : null;
          } catch (_) { return null; }
        },
        historyLinkSelector: "a[href^='/chat/'], a[href^='https://www.doubao.com/chat/']",
        async prepareHistory({ wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 15_000 } = {}) {
          const startedAt = Date.now();
          let opened = false;
          while (true) {
            if (document.querySelector(this.historyLinkSelector)) return true;
            if (!opened) {
              const button = Array.from(document.querySelectorAll("button"))
                .find((node) => /(对话|列表|侧边|sidebar)/i.test(node.getAttribute("aria-label") || "") && !node.disabled && isVisibleElement(node));
              if (button) { button.click(); opened = true; }
            }
            const remaining = timeoutMs - (Date.now() - startedAt);
            if (remaining <= 0) return false;
            await wait(Math.min(120, remaining));
          }
        },
        buildHistoryEntry(anchor) {
          try {
            const url = new URL(anchor.getAttribute("href"), "https://www.doubao.com").href;
            const id = this.getChatIdFromUrl(url);
            return id ? { id, title: anchor.textContent.trim(), chatUrl: url } : null;
          } catch (_) { return null; }
        },
        // Doubao's web chat does not accept a file through this bridge: the
        // web_sync transport declares fileInputs:false, so asking it to upload
        // would only produce a "input not found" failure like Gemini's.
        supportsFileUpload: false,
        supportsModelSelector: false,
        hasFormWrapper: true,
      };
    },
  };
})(globalThis);
