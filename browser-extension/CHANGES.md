# llm-for-zotero Bridge — changes to sync-for-zotero

`browser-extension/` in this directory is a **modified copy** of
[sync-for-zotero](https://github.com/yilewang/sync-for-zotero),
Copyright Yile Wang, licensed under the **Apache License, Version 2.0**
(the full text is in `LICENSE` in this directory).

This file is the section 4(b) "changed files" notice for the two files that
cannot carry an inline comment — `manifest.json`, because JSON does not permit
comments, and `popup.html`'s markup, where a header would be rendered. Every
other changed `.js` file carries the same notice in its first lines, prefixed
with `SPDX-License-Identifier: Apache-2.0`.

Nothing here is relicensed. These files remain Apache-2.0.

## Files changed

| File | Nature of the change |
|---|---|
| `manifest.json` | Added `https://www.doubao.com/*` to `host_permissions` and to `content_scripts` matches; removed the invalid `windows` permission, which is not a real Chrome permission and prevented the extension from loading; **renamed the product and reset the version to `0.1.0`**, because Apache-2.0 section 6 does not grant the browser extension's own product name and our higher version number was indistinguishable from an official release. The product was first called `Zotero LLM Bridge (Unofficial)`, then renamed again to `llm-for-zotero Bridge (Unofficial)` so the name states which add-on it extends — see NOTICE.md for why that is within the licence. |
| `popup.html` | Displays the background `buildId` so a reloaded extension can be confirmed; product name updated, with an explicit "unofficial patch build" line under the heading. |
| `content_script.js` | Doubao turn binding via per-role ordinal message keys, a submit-time baseline snapshot, and a pre-existing-turn guard at both poll and emit time; images and links converted to Markdown instead of dropped; the chat-window minimised check demoted to a diagnostic that can never block or un-focus a submission; position-based turn fallback available to every site. |
| `background.js` | Skips tabs in minimised windows when choosing a chat target; never raises, activates or restores a browser window; exposes `buildId` in the status response; the minimised pre-flight warns instead of throwing. |
| `doubao_adapter.js` | **New file.** Upstream ships no Doubao adapter. Candidate-first node resolution, ordinal-based message identity, pointer-sequence submit. |
| `gemini_adapter.js` | Four-tier fallback for locating the hidden file input, including a document-wide search that penetrates shadow DOM; on total failure, throws with a full `data-testid` census so the next report names real selectors. |
| `webchat_shared.js` | Accepts Doubao's CSS-truncated PDF file names in attachment receipts; non-PDF files still rejected. |
| `popup.js`, `injected.js` | Minor: buildId display, and an unchanged file retained for context. |

## Attribution

Per Apache-2.0 section 4(d), the notices above are reproduced for the
convenience of recipients. The authoritative attribution is the `LICENSE`
file and the upstream project.
