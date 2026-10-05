# NOTICE

This project is **not** an official product of, and is not endorsed or
maintained by, the authors of the projects it builds on.

All trademarks belong to their respective owners.

### Why the browser extension is not called "Sync for Zotero"

Apache-2.0 section 6 grants the copyright licence but explicitly does **not**
grant permission to use the licensor's trade names, trademarks or product
names. Shipping a modified build under the *browser extension's* own product
name would fall outside that grant, and it is also practically confusing: our
build carried a higher version number than the upstream release, so a user with
both installed could not tell which one was which and could reasonably believe
the upstream author had published our Doubao work.

The extension is therefore named **`llm-for-zotero Bridge (Unofficial)`** and
versioned independently of upstream (we start at `0.1.0`; the browser-extension
upstream is at `0.0.17`).

Our name does contain the string `llm-for-zotero`, and that is deliberate. That
is the name of the **Zotero add-on** this project patches — a different product,
under a different licence (AGPL-3.0), which we are not redistributing under its
own name. Apache-2.0 section 6 permits using a name "as reasonably necessary to
describe the origin of the work"; naming the extension after the add-on it
extends describes exactly that, and `(Unofficial)` plus the in-product notice
state the relationship plainly so no user can mistake it for the add-on itself.

We keep both upstream names only where section 6 allows it: in notices
describing the origin of the work. Every modified file still carries the
original copyright attribution, and the browser extension is versioned on its
own line so it can never be mistaken for an official release.

---

## Third-party projects this builds on

### 1. llm-for-zotero

- Upstream: <https://github.com/yilewang/llm-for-zotero>
- Author: Yile Wang
- Licence: **AGPL-3.0**
- What we depend on: the Zotero add-on as a whole. We patch the bundled
  `content/scripts/llmforzotero.js` and the preferences UI.

`dist/patched-llm-for-zotero-*.xpi` is a **derivative work** of llm-for-zotero
and is therefore distributed under **AGPL-3.0**, not MIT.

We satisfy the AGPL's source-availability requirement by shipping, in this same
repository, everything needed to rebuild that .xpi from a stock upstream copy:

```
python apply.py --xpi /path/to/llm-for-zotero.xpi
```

The patch scripts in `zotero-patches/patches/` are the complete expression of
our modifications: they contain the string anchors and their replacements, and
they read the user's own copy of the official add-on at build time. No upstream
source is committed to this repository.

If you redistribute the patched .xpi, you must keep it under AGPL-3.0 and
convey the same build scripts. Upstream's own TypeScript sources are published
in its repository and remain the property of their authors.

### 2. sync-for-zotero

- Upstream: <https://github.com/yilewang/sync-for-zotero>
- Author: Yile Wang
- Licence: **Apache-2.0**
- What we depend on: the browser-extension side of the webchat bridge.

`browser-extension/` is a derivative work of sync-for-zotero and stays under
**Apache-2.0**. Per section 4 of that licence the attribution notices are
retained: every changed file keeps the original copyright line and adds a
header naming what we changed, and the full licence text is shipped alongside.
The product has been renamed to `llm-for-zotero Bridge (Unofficial)` — see the
section above for why.

Our changes to that project are substantial and worth naming:

| Area | What we changed |
|---|---|
| `doubao_adapter.js` | **New file.** A Doubao (豆包) site adapter, which upstream does not ship at all. |
| Gemini adapter | Multi-tier fallback for locating the hidden `input[type=file]`; a document-wide and shadow-DOM-penetrating search replaced two hardcoded assumptions. |
| Turn identity | Doubao exposes no per-message id, so keys are minted from each bubble's ordinal among its role, and both the submit-time snapshot and the emit-time check reject a pre-existing reply. |
| Media passthrough | Images and links survive the DOM-to-Markdown step: lazy-loaded `src`/`data-src`/`srcset`/`currentSrc` are probed in order of trustworthiness, and a 1x1 placeholder GIF is explicitly rejected so a real image wins. |
| Diagnostics | The relay reports the observed `data-testid` vocabulary, so a DOM change produces one useful error instead of a guess. |
| Focus behaviour | The adapter never raises, activates or restores a browser window. |

### 3. Tavily

- <https://tavily.com>
- Referenced only as the *default* upstream behaviour that our free-engine
  provider replaces. We redistribute none of their code.

A note that is easy to misread: Tavily does offer a free monthly credit
allowance and does not sell API keys. These patches remove the **registration
step**, not a payment. They replace a service that was already free with
another one that is free.

---

## What is ours

Everything under `zotero-patches/` and `install.py` — the search-quality work,
the per-run search ledger, the segment-stall guard, the Doubao integration on
the Zotero side, the portable Node detection, and the installer. MIT; see
`LICENSE-MIT.txt`.

## Trademarks

"Sync for Zotero", "llm-for-zotero", "Zotero", "Doubao" and "Tavily" are
trademarks of their respective owners. This project is an independent
compatibility layer and claims no endorsement. We use those names only to
describe what this project connects to and what it patches, which is the use
Apache-2.0 section 6 permits. Our extension appends "Bridge (Unofficial)" to
the add-on name it extends and is versioned on an independent line, so it
cannot be mistaken for an official build of either upstream product.
