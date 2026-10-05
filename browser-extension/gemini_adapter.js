// SPDX-License-Identifier: Apache-2.0
//
// This file is a MODIFIED version of sync-for-zotero
// (https://github.com/yilewang/sync-for-zotero), Copyright Yile Wang,
// licensed under the Apache License, Version 2.0 (see ./LICENSE).
//
// Changes made by the zotero-llm-bridge contributors:
//   - Four-tier fallback for locating the hidden file input: an already-mounted
//     input, then clicking the composer control, then clicking the upload menu
//     item (Chinese and English labels), then a document-wide search that
//     penetrates shadow DOM.
//   - On total failure, throws with a full data-testid census so the next
//     report names real selectors instead of guessing again.
//
// Under Apache-2.0 section 4(b) this notice is retained in the source form of
// the derivative work. It is NOT relicensed; the file remains Apache-2.0.
//

// Gemini has no verified network capture contract. Keep all site DOM knowledge
// here; the existing delivery/turn tracker owns sequencing and acknowledgements.
(function (root) {
  root.SyncZoteroGemini = {
    createAdapter({ document, isVisibleElement, htmlToMarkdown, shared }) {
      const composerSelector = '.ql-editor[role="textbox"][contenteditable="true"]';
      const inputRoot = () => document.querySelector(composerSelector)?.closest("input-container") || document.querySelector("input-container");
      const iconButton = (icon) => {
        const button = inputRoot()?.querySelector(`mat-icon[fonticon="${icon}"]`)?.closest("button");
        return button && isVisibleElement(button) ? button : null;
      };
      const messageRole = (node) => node?.localName === "user-query" ? "user" : node?.localName === "model-response" ? "assistant" : null;
      const turnIdentities = new WeakMap();
      const permanentTurnIdentities = new Map();
      let provisionalTurnSerial = 0;
      const messageId = (node) => {
        const turn = node?.closest(".conversation-container");
        const role = messageRole(node);
        if (!turn || !role) return null;
        // Gemini exposes a user turn before assigning its permanent ID. Keep
        // the first node identity for that turn, then remember its eventual ID
        // so replacing the DOM node cannot invalidate an in-flight binding.
        let identity = turnIdentities.get(turn);
        if (!identity) {
          identity = permanentTurnIdentities.get(turn.id) || turn.id ||
            `gemini-provisional-turn-${++provisionalTurnSerial}`;
          turnIdentities.set(turn, identity);
        }
        if (turn.id) permanentTurnIdentities.set(turn.id, identity);
        return `${identity}:${role}`;
      };
      const clean = (node) => {
        const clone = node.cloneNode(true);
        // Gemini's HTML-only KaTeX keeps the source on data-math; preserve it
        // before removing aria-hidden rendering trees. Work on the clone only.
        clone.querySelectorAll('[data-math]').forEach((el) => {
          const latex = el.getAttribute('data-math')?.trim();
          if (!latex) return;
          const display = el.classList.contains('math-block') ||
            el.classList.contains('katex-display') || Boolean(el.querySelector('.katex-display'));
          el.replaceWith(document.createTextNode(display ? `\n$$${latex}$$\n` : `$${latex}$`));
        });
        // Keep web source links, but omit other badges and their UI labels
        // from captured answers. Ordinary answer text is left untouched.
        clone.querySelectorAll('source-inline-chip, .source-inline-chip-container').forEach((chip) => {
          if (!clone.contains(chip)) return; // already replaced an outer chip
          const links = Array.from(chip.querySelectorAll('a[href]')).filter((a) => /^https?:\/\//i.test(a.getAttribute('href') || ''));
          if (!links.length) {
            chip.remove();
            return;
          }
          const replacement = document.createElement('span');
          replacement.appendChild(document.createTextNode(' ['));
          links.forEach((a, index) => {
            if (index) replacement.appendChild(document.createTextNode('; '));
            const link = document.createElement('a');
            link.setAttribute('href', a.getAttribute('href'));
            link.textContent = a.getAttribute('aria-label') || a.textContent.trim() || a.getAttribute('href');
            replacement.appendChild(link);
          });
          replacement.appendChild(document.createTextNode(']'));
          chip.replaceWith(replacement);
        });
        clone.querySelectorAll('button, [role="button"], [hidden], [aria-hidden="true"], .cdk-visually-hidden').forEach((el) => el.remove());
        return clone;
      };
      const withExtension = (stem, extension) => {
        if (!stem) return "";
        const suffix = String(extension || "").trim().toLowerCase();
        return suffix && !stem.toLowerCase().endsWith(`.${suffix}`) ? `${stem}.${suffix}` : stem;
      };
      const normalizePdfFilename = (name) => String(name || "")
        .normalize("NFC").trim().replace(/\.pdf$/i, ".pdf");
      const composerFilenameMatches = (label, filename) => {
        const actual = normalizePdfFilename(label);
        const expected = normalizePdfFilename(filename);
        if (actual === expected) return true;
        // Gemini puts a middle elision in the DOM, not just CSS overflow.
        // Use both retained ends of the basename, only for the new upload card.
        // The submitted user turn must still expose the complete filename.
        if (!actual.endsWith(".pdf") || !expected.endsWith(".pdf")) return false;
        const parts = actual.slice(0, -4).split(/…|\.\.\./);
        if (parts.length !== 2) return false;
        const [prefix, suffix] = parts;
        const basename = expected.slice(0, -4);
        return prefix.length >= 4 && suffix.length >= 4 &&
          prefix.length + suffix.length >= 16 &&
          prefix.length + suffix.length < basename.length &&
          basename.startsWith(prefix) && basename.endsWith(suffix);
      };
      const getComposerAttachments = () => Array.from(inputRoot()?.querySelectorAll("uploader-file-preview") || [])
        .filter(isVisibleElement)
        .map((node) => {
          const filename = withExtension(node.querySelector(".gem-attachment-text")?.textContent.trim(), node.querySelector(".gem-attachment-extension-label")?.textContent);
          const image = Boolean(node.querySelector('gem-media-attachment img'));
          const closeButton = node.querySelector('mat-icon[fonticon="close"]')?.closest("button") || node.querySelector('button[aria-label^="close"]');
          const busy = node.querySelector('mat-progress-spinner, mat-spinner, progress, [role="progressbar"], [aria-busy="true"]');
          const failed = node.querySelector('[role="alert"], .upload-error') || /upload failed|上传失败/i.test(node.textContent);
          return { node, filename: filename || (image ? "image" : (busy || closeButton ? "pending attachment" : "")), kind: image ? "image" : "file", ready: Boolean((filename || image) && closeButton && !closeButton.disabled && closeButton.getAttribute("aria-disabled") !== "true" && !busy && !failed) };
        }).filter((card) => card.filename);
      // === BEGIN GEMINI UPLOAD FIX (helpers) ===
      const fzgDeepFileInputs = (sel) => {
        const out = Array.from(document.querySelectorAll(sel));
        const seenRoots = new WeakSet();
        const walk = (root, depth) => {
          if (!root || depth > 6) return;
          root.querySelectorAll("*").forEach((el) => {
            const sr = el.shadowRoot;
            if (!sr || seenRoots.has(sr)) return;
            seenRoots.add(sr);
            try {
              out.push(...Array.from(sr.querySelectorAll(sel)));
            } catch (_) { /* cross-origin shadow, ignore */ }
            walk(sr, depth + 1);
          });
        };
        walk(document, 0);
        return Array.from(new Set(out));
      };
      const fzgAnyFileInput = () => {
        const all = fzgDeepFileInputs('input[type="file"]');
        if (!all.length) return null;
        const scoped = all.find((el) => el.closest("input-container, images-files-uploader, uploader"));
        return scoped || all[0];
      };
      const fzgVisibleish = (el) => {
        if (!el) return false;
        try {
          return isVisibleElement(el) || el.offsetParent !== undefined;
        } catch (_) { return true; }
      };
      const fzgClickableButton = (node) => {
        const btn = node?.closest("button") || (node?.tagName === "BUTTON" ? node : null);
        return btn && !btn.disabled && fzgVisibleish(btn) ? btn : null;
      };
      const fzgIconText = (node) => {
        const container = node?.closest("button, [role=button], li, [role=menuitem], [role=option]") || node;
        return (container?.getAttribute("aria-label") || "") + " " + (container?.textContent || "");
      };
      const fzgFindPlusControl = () => {
        const candidates = [];
        const push = (node, how) => {
          const btn = fzgClickableButton(node);
          if (btn && !candidates.some((c) => c.node === btn)) candidates.push({ node: btn, how });
        };
        inputRoot()?.querySelectorAll("mat-icon").forEach((el) => {
          const icon = el.getAttribute("fonticon") || "";
          const text = (el.textContent || "").trim();
          if (/^(plus|add|attach\w*|upload\w*)$/i.test(icon) || /^(add|attach\w*)$/i.test(text)) push(el, "icon:" + (icon || text));
        });
        inputRoot()?.querySelectorAll("button, [role=button]").forEach((el) => {
          const label = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("data-test-id") || "");
          if (/attach|upload|add file|add photo/i.test(label)) push(el, "aria:" + label.trim().slice(0, 40));
        });
        const legacy = iconButton("plus");
        if (legacy) push(legacy, "legacy:mat-icon[fonticon=plus]");
        return candidates;
      };
      const fzgMenuLabels = [
        /upload (photos?|files?|photos? & files?)/i,
        /^(add|upload) (your )?files?$/i,
        /upload/i,
        /attach/i,
        /上传\s*(照片|文件|图片)/,
        /添加\s*(照片|文件|图片)/,
        /从.*上传/,
      ];
      const fzgFindMenuUploadItem = () => {
        const nodes = Array.from(document.querySelectorAll(
          '[role="menuitem"], [role="option"], [role="menuitemradio"], li[class*="item"], div[class*="menu-item"], button'
        )).filter((el) => {
          const r = el.getBoundingClientRect();
          return fzgVisibleish(el) && r.width > 0 && r.height > 0 && r.height < 120;
        });
        for (const pattern of fzgMenuLabels) {
          const hit = nodes.find((el) => pattern.test(fzgIconText(el)) && fzgClickableButton(el));
          if (hit) return { node: fzgClickableButton(hit) || hit, how: "menu:" + String(pattern).slice(0, 30) };
        }
        return null;
      };
      const fzgCensus = () => {
        const inputs = fzgDeepFileInputs('input[type="file"]').map((el) => ({
          accept: el.getAttribute("accept") || "",
          multiple: el.hasAttribute("multiple"),
          parentChain: (() => {
            const names = [];
            let cur = el;
            for (let i = 0; i < 4 && cur; i += 1) { cur = cur.parentElement; if (cur) names.push(cur.localName); }
            return names.join("<");
          })(),
        }));
        const icons = Array.from(inputRoot()?.querySelectorAll("mat-icon") || [])
          .map((el) => el.getAttribute("fonticon") || (el.textContent || "").trim())
          .filter(Boolean).slice(0, 24);
        const buttons = Array.from(inputRoot()?.querySelectorAll("button") || [])
          .map((el) => el.getAttribute("aria-label") || "").filter(Boolean).slice(0, 24);
        return {
          composerFound: Boolean(document.querySelector(composerSelector)),
          inputContainerFound: Boolean(inputRoot()),
          imagesFilesUploaderFound: Boolean(document.querySelector("images-files-uploader")),
          fileInputCount: inputs.length,
          fileInputs: inputs.slice(0, 6),
          matIcons: icons,
          composerButtons: buttons,
        };
      };
      // === END GEMINI UPLOAD FIX (helpers) ===
      return {
        siteId: "gemini", homeUrl: "https://gemini.google.com/app", answerCapture: "dom",
        composerSelectors: [composerSelector],
        sendButtonSelectors: () => iconButton("arrow_upward"),
        findStopButton: () => iconButton("stop"),
        findUploadControl: () => iconButton("plus"),
        stopButtonSelectors: [],
        userMessageSelector: ".conversation-container user-query",
        assistantMessageSelectors: [".conversation-container model-response"],
        conversationMessageSelector: ".conversation-container user-query, .conversation-container model-response",
        conversationTurnSelector: ".conversation-container",
        getMessageRole: messageRole, getMessageId: messageId,
        extractUserMessageText(node) {
          return Array.from(node.querySelectorAll(".query-text-line")).map((line) => htmlToMarkdown(clean(line).innerHTML).trim()).join("\n").trim();
        },
        extractAssistantAnswerText(node) {
          const markdown = node?.querySelector("message-content .markdown");
          if (!markdown) return "";
          const answer = htmlToMarkdown(clean(markdown).innerHTML).trim();
          // Some sources are rendered in the response footer, outside the
          // Markdown owner. Export actual web links, not the surrounding UI.
          const sources = document.createElement('div');
          const seen = new Set();
          node.querySelectorAll('sources-list a[href], .sources-list a[href]').forEach((anchor) => {
            const href = anchor.getAttribute('href') || '';
            if (markdown.contains(anchor) || !/^https?:\/\//i.test(href) || seen.has(href)) return;
            seen.add(href);
            const paragraph = document.createElement('p');
            const link = document.createElement('a');
            link.setAttribute('href', href);
            link.textContent = anchor.textContent.trim() || anchor.getAttribute('aria-label') || href;
            paragraph.appendChild(link);
            sources.appendChild(paragraph);
          });
          const sourceText = htmlToMarkdown(sources.innerHTML).trim();
          return sourceText ? `${answer}\n\n${sourceText}`.trim() : answer;
        },
        extractAssistantThinkingText: () => "",
        extractAttachmentNames(node) {
          if (messageRole(node) !== "user") return [];
          const names = Array.from(node.querySelectorAll('user-query-file-preview [data-test-id="uploaded-file"]')).map((card) => withExtension(card.querySelector('[data-test-id="filename-label"]')?.textContent.trim(), card.querySelector(".extension-label")?.textContent)).filter(Boolean);
          const images = node.querySelectorAll('user-query-file-preview img, user-query-media img');
          images.forEach((_, index) => names.push(images.length === 1 ? "image" : `image_${index + 1}`));
          return names;
        },
        isResponseComplete(assistantTurnKey) {
          if (!assistantTurnKey) return false;
          const node = Array.from(document.querySelectorAll(".conversation-container model-response")).find((candidate) => messageId(candidate) === assistantTurnKey);
          return Boolean(node && isVisibleElement(node) && node.querySelector('message-content .markdown[aria-busy="false"]') && node.querySelector(".response-footer.complete"));
        },
        getComposerAttachments,
        classifySubmittedAttachments(attachments, expectedFilename, expectedImageCount = 0) {
          const contract = shared.classifySubmittedPdfContract(attachments, expectedFilename);
          // Gemini exposes the complete filename stem and extension separately.
          // Its receipt must not inherit legacy substring/elision/rename matches.
          const filenameMatched = expectedFilename
            ? attachments.some((name) => normalizePdfFilename(name) === normalizePdfFilename(expectedFilename))
            : null;
          const imageCount = attachments.filter((name) => /^image(?:_\d+)?$/.test(name)).length;
          const pdfVerified = expectedFilename
            ? contract.pdfAttachmentCount === 1 && filenameMatched === true
            : contract.pdfAttachmentCount === 0;
          return { ...contract, filenameMatched, contractVerified: pdfVerified &&
            imageCount === expectedImageCount &&
            attachments.length === (expectedFilename ? 1 : 0) + expectedImageCount };
        },
        resolveReplacementUserTurn({ transcript, baseline, expectedChatUrl, promptText, expectedPdfFilename, expectedImageCount }) {
          const conversationUrl = shared.normalizeGeminiConversationUrl(expectedChatUrl || baseline.chatUrl);
          if (!conversationUrl || shared.normalizeGeminiConversationUrl(transcript.chatUrl) !== conversationUrl) return null;
          // A replaced provisional node has no observable link to its new ID.
          // Rebind only while the entire pre-send baseline remains identifiable
          // in order, with exactly one subsequent user carrying this request.
          let boundary = -1;
          for (const message of baseline.messages) {
            const index = transcript.messages.findIndex((candidate) => candidate.messageKey === message.messageKey);
            if (index <= boundary) return null;
            boundary = index;
          }
          const users = transcript.messages.slice(boundary + 1).filter((message) => message.role === "user");
          if (users.length !== 1) return null;
          const candidate = users[0];
          const normalizePrompt = (text) => String(text || "").normalize("NFC").replace(/\s+/g, " ").trim();
          if (normalizePrompt(candidate.text) !== normalizePrompt(promptText)) return null;
          const attachments = Array.isArray(candidate.attachments) ? candidate.attachments : [];
          const contract = this.classifySubmittedAttachments(attachments, expectedPdfFilename, expectedImageCount);
          return contract.contractVerified ? candidate : null;
        },
        // === BEGIN GEMINI UPLOAD FIX (uploadFile) ===
        async uploadFile(file, { wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), timeoutMs = 45000 } = {}) {
          const startedAt = now();
          const MENU_DELAY_MS = 900;
          const POLL_MS = 100;
          let openedVia = null;
          const pollFor = async (budgetMs) => {
            const deadline = startedAt + budgetMs;
            let input = fzgAnyFileInput();
            while (!input && now() < deadline) {
              await wait(POLL_MS);
              input = fzgAnyFileInput();
            }
            return input;
          };

          // Stage 0 -- maybe the picker input is already mounted.
          let input = fzgAnyFileInput();

          // Stage 1 -- click the composer's plus/attach control, then poll.
          if (!input) {
            const controls = fzgFindPlusControl();
            for (const control of controls) {
              control.node.click();
              openedVia = control.how;
              input = await pollFor(1200);
              if (input) break;
            }
          }

          // Stage 2 -- a popover menu most likely opened; click the upload entry.
          if (!input) {
            const item = fzgFindMenuUploadItem();
            if (item) {
              item.node.click();
              openedVia = (openedVia ? openedVia + "+" : "") + item.how;
              input = await pollFor(Math.max(2000, Math.min(timeoutMs, 8000)));
            }
          }

          // Stage 3 -- the menu may animate in late; keep polling a little more.
          if (!input) input = await pollFor(Math.max(1500, MENU_DELAY_MS * 2));

          if (!input) {
            const census = fzgCensus();
            throw new Error(`Gemini upload file input was not found. OpenedVia=${openedVia || "none"}. DOM=${JSON.stringify(census)}`);
          }

          const transfer = new DataTransfer();
          transfer.items.add(file);
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const baseline2 = new Set(getComposerAttachments().map((card) => card.node));
          let readySince = null;
          while (now() - startedAt <= timeoutMs) {
            const cards = getComposerAttachments().filter((card) => !baseline2.has(card.node));
            const matching = cards.filter((card) => file.type.startsWith("image/")
              ? card.kind === "image"
              : card.kind === "file" && composerFilenameMatches(card.filename, file.name));
            if (matching.length === 1 && cards.length === 1 && matching[0].ready) {
              if (readySince === null) readySince = now();
              if (now() - readySince >= 750) {
                return { method: "file_input", filenameConfirmed: !file.type.startsWith("image/"), readyConfirmed: true, evidence: matching[0].filename, totalElapsedMs: now() - startedAt, openedVia };
              }
            } else {
              readySince = null;
            }
            if (now() - startedAt >= timeoutMs) break;
            await wait(POLL_MS);
          }
          throw new Error(`Gemini did not confirm a ready attachment for "${file.name}". OpenedVia=${openedVia || "none"}`);
        },
        // === END GEMINI UPLOAD FIX (uploadFile) ===
        getChatIdFromUrl(url) { return shared.normalizeGeminiConversationUrl(url)?.split("/").pop() || null; },
        historyLinkSelector: 'bard-sidenav a[href^="/app/"], bard-sidenav a[href^="https://gemini.google.com/app/"]',
        async prepareHistory({ wait, now = Date.now, timeoutMs = 15_000 } = {}) {
          const startedAt = now();
          let opened = false;
          while (true) {
            if (document.querySelector(this.historyLinkSelector)) return true;
            if (!opened) {
              const button = Array.from(document.querySelectorAll('button[aria-label="Open sidebar"]'))
                .find((node) => !node.disabled && isVisibleElement(node));
              if (button) {
                button.click();
                opened = true;
              }
            }
            const remaining = timeoutMs - (now() - startedAt);
            if (remaining <= 0) return false;
            await wait(Math.min(100, remaining));
          }
        },
        buildHistoryEntry(anchor) {
          const url = new URL(anchor.getAttribute("href"), "https://gemini.google.com").href;
          const chatUrl = shared.normalizeGeminiConversationUrl(url);
          return chatUrl ? { id: chatUrl.split("/").pop(), title: anchor.textContent.trim(), chatUrl } : null;
        },
        supportsFileUpload: true, supportsModelSelector: false, hasFormWrapper: false,
      };
    },
  };
})(globalThis);
