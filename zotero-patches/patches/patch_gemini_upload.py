# -*- coding: utf-8 -*-
"""
patch_gemini_upload.py
======================

Fix: "Gemini upload file input was not found." when attaching a PDF/image
through the sync-for-zotero WebChat bridge.

ROOT CAUSE
----------
In upstream v0.0.16, `extension/gemini_adapter.js::uploadFile` does:

    let input = document.querySelector('images-files-uploader input[type="file"]');
    if (!input) {
      const upload = iconButton("plus");
      if (!upload) throw new Error("Gemini upload control was not found.");
      upload.click();
      while (!input && elapsed < 10s) {
        input = document.querySelector('images-files-uploader input[type="file"]');
        ...
      }
    }
    if (!input) throw new Error("Gemini upload file input was not found.");

Two assumptions break on current Gemini:

  1. The plus button opens the file picker DIRECTLY. Current Gemini opens a
     popover menu first ("Upload photos & files" / "Import from Drive" ...);
     the <input type="file"> is only created after that menu item is clicked.
  2. The file input always lives under a custom element named exactly
     `images-files-uploader`. A rename, a shadow root, or a plain hidden
     <input> anywhere in the composer all defeat the scoped selector.

Because uploadFile throws, the pipeline never reaches the send phase, and the
bridge reports the failure with `send=not_found, clicks=0` -- which looks like
a send-button problem but is actually an upstream upload problem.

THE FIX
-------
Replace uploadFile with a multi-stage resolver:

  Stage 0  Reuse an input that ALREADY exists (widest search first).
  Stage 1  Click the plus control (several selector strategies), then poll.
  Stage 2  If after ~1.2s still nothing, look for the popover menu and click
           the upload item (matched by aria-label / data-test-id / text,
           English + Chinese).
  Stage 3  Poll again for any file input, document-wide and shadow-penetrating.
  Stage 4  Give up -> throw an error carrying a full DOM census so the next
           report contains exact selectors instead of a guess.

Nothing else in the adapter is touched. The failure-mode diagnostics are the
important part: an unfixable Gemini redesign should surface precise evidence
rather than one hardcoded selector's obituary.

IDEMPOTENT: safe to re-run. Re-applies to a pristine copy every time by
restoring from *.orig first.

Usage:
    python patch_gemini_upload.py [--extension=DIR]

--extension must be the *unpacked* sync-for-zotero extension directory that
contains gemini_adapter.js. Defaults to $SYNC_EXTENSION_DIR, then ./extension.
"""

import io
import os
import sys

_root = None
for _arg in sys.argv[1:]:
    if _arg.startswith("--extension="):
        _root = _arg.split("=", 1)[1]
_root = _root or os.environ.get("SYNC_EXTENSION_DIR") or \
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "extension")

ADAPTER = os.path.join(_root, "gemini_adapter.js")
BAK = ADAPTER + ".orig"


# --------------------------------------------------------------------------
# Shared helpers injected next to the existing helpers inside createAdapter().
# Injected verbatim; keep indentation at 6 spaces (inside the factory body).
# --------------------------------------------------------------------------
HELPERS = '''      // === BEGIN GEMINI UPLOAD FIX (helpers) ===
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
          if (/^(plus|add|attach\\w*|upload\\w*)$/i.test(icon) || /^(add|attach\\w*)$/i.test(text)) push(el, "icon:" + (icon || text));
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
        /上传\\s*(照片|文件|图片)/,
        /添加\\s*(照片|文件|图片)/,
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
'''


NEW_UPLOAD = '''        // === BEGIN GEMINI UPLOAD FIX (uploadFile) ===
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
'''


def main():
    if not os.path.exists(ADAPTER):
        sys.exit("adapter not found: %s" % ADAPTER)
    if not os.path.exists(BAK):
        io.open(BAK, "w", encoding="utf-8", newline="").write(
            io.open(ADAPTER, encoding="utf-8", newline="").read()
        )
        print("backup -> %s" % os.path.basename(BAK))

    code = io.open(BAK, encoding="utf-8", newline="").read()

    # 1. inject helpers right before the `return {` of the adapter object
    anchor = "      return {\n        siteId: \"gemini\","
    if anchor not in code:
        sys.exit("FAIL: adapter return block not found")
    code = code.replace(anchor, HELPERS + anchor, 1)
    print("OK   helpers injected")

    # 2. replace the whole original uploadFile method
    start = code.index("        async uploadFile(file,")
    end = code.index("        getChatIdFromUrl(url)", start)
    old_len = end - start
    code = code[:start] + NEW_UPLOAD + code[end:]
    print("OK   uploadFile replaced (%d chars -> %d chars)" % (old_len, len(NEW_UPLOAD)))

    io.open(ADAPTER, "w", encoding="utf-8", newline="").write(code)
    print("patched OK")


if __name__ == "__main__":
    main()
