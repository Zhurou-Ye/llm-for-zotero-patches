# llm-for-zotero-patches

Unofficial patch package for [`llm-for-zotero`](https://github.com/yilewang/llm-for-zotero), the Zotero AI add-on. It adds two capabilities the add-on does not provide: **key-less web search**, and **Doubao (豆包) web-bridge support**.

[![License](https://img.shields.io/badge/patched%20.xpi-AGPL--3.0-blue.svg?style=flat-square)](https://www.gnu.org/licenses/agpl-3.0)
[![License](https://img.shields.io/badge/patches-MIT-green.svg?style=flat-square)](LICENSE-MIT.txt)
[![Extension](https://img.shields.io/badge/browser%20extension-Apache--2.0-blueviolet.svg?style=flat-square)](browser-extension/LICENSE)

<!-- Screenshots: one showing a Doubao answer inside a Zotero note; one showing the
     provider dropdown in Zotero preferences. GIFs under 800px wide are preferable. -->

> **This is an unofficial project.** It is not maintained, endorsed, or reviewed
> by the upstream author (Yile Wang). It patches a specific upstream release; it
> is not a fork and carries no upstream commit history.
>
> Upstream add-on: <https://github.com/yilewang/llm-for-zotero> — AGPL-3.0, © Yile Wang
> Upstream browser extension: <https://github.com/yilewang/sync-for-zotero> — Apache-2.0, © Yile Wang
>
> Full attribution: [NOTICE.md](NOTICE.md).

---

## Scope

This repository ships two independent components. Installing one does not
require the other.

| Component | Install target | Effect |
|---|---|---|
| **Patched add-on**<br>`dist/patched-llm-for-zotero-3.9.10.9.xpi` | Zotero add-on `llm-for-zotero` | Replaces the web-search provider with a key-less multi-engine provider. No third-party account is required. |
| **Browser extension**<br>`llm-for-zotero Bridge (Unofficial)` | Chrome / Edge | Adds Doubao as a WebChat target, so Doubao answers are written back into Zotero notes, including images and links. |

Doubao support requires both components. The key-less search provider is
independent of Doubao support.

---

## Verification basis

Every statement below about upstream behaviour was checked against unmodified
upstream sources, not against a patched build:

| Claim | Verified against | Result |
|---|---|---|
| Doubao is not supported upstream | `llm-for-zotero` v3.9.10, `content/scripts/llmforzotero.js` | `WEBCHAT_TARGETS` contains exactly `chatgpt`, `deepseek`, `gemini`; the string `doubao` occurs **0 times** |
| Doubao is not supported by the extension | `sync-for-zotero`, `main` branch, `extension/content_script.js` | `doubao` occurs **0 times**; the extension ships three adapters, for ChatGPT, DeepSeek and Gemini |
| Images are not carried through by the DOM-to-Markdown step | `sync-for-zotero`, `htmlToMarkdown` | `case "img"` returns alt text only; the source comment reads `// Images are not synced` |
| The position-based turn fallback is DeepSeek-only | `sync-for-zotero`, submit path | guarded by `deepseekRequestObserved` |
| A segment with no new tool progress fails the whole run | `llm-for-zotero` v3.9.10, agent loop | `if (!newFingerprints.length && !settledNewTargets)` calls `completeRun(finalText, "failed")` |

`zotero-patches/tests/test_readme_claims.js` enforces these claims
mechanically. The test reads the shipped bundle and fails if this document
states a patched-build value as an upstream fact, or claims upstream has a
feature it lacks.

---

## Changes

### 1. Key-less web search

Upstream implements web search against the Tavily API and requires the user to
register for a key. This package substitutes a self-contained multi-engine
provider that queries Bing (three domains), 360, DuckDuckGo and Mojeek, stopping
at the first engine that returns results.

Tavily is not a paid service: its free tier provides 1,000 API credits per
month, requires no credit card, and upstream's author does not sell keys. What
this package removes is the **registration step**, not a charge.

A key-less provider is only useful if the results are usable, so the measured
snippet quality is the relevant figure:

| Provider | Mean characters per result | 10-result total |
|---|---|---|
| Tavily | 513 characters | 5133 |
| Key-less engines, before enrichment | 58 characters | 523 |

Search-result meta descriptions are marketing filler for many Chinese
commercial sites, which is why the mean is an order of magnitude lower. The
patch fetches result pages concurrently and substitutes extracted body text
for the snippet, which is what makes the key-less provider viable.

Two further changes keep search convergent, since `web_search` is stateless from
the agent's point of view:

| Behaviour | Upstream | Change |
|---|---|---|
| A reworded query re-runs the same search | No duplicate detection | Each query is recorded in a per-run ledger as a token set. On Jaccard overlap ≥ 0.6 against an earlier query, the tool result states the degree of overlap instead of returning duplicates |
| Search continues until the agent round cap is reached | A round cap (`MAX_AGENT_ROUNDS`) but no budget on search calls | A hard budget (default 6 searches per run). Once exhausted, the tool returns a `QUOTA EXHAUSTED` instruction requiring the model to answer from what it already has |

#### Incidental fix: segment stall

While debugging the key-less provider above, one upstream failure mode surfaced
that is worth recording but is not a feature of this package.

On a literature request the agent repeatedly asks for the same set of arXiv
papers. Progress fingerprints then collide across segments, and upstream treats
the first no-progress segment as a hard failure — the sources already retrieved
and the partially written answer are discarded together. The upstream branch
does discard the answer, as recorded in the verification table above.

The patch adds a guard: the first no-progress segment appends a wrap-up
instruction so the model can finish from the material it already holds, and the
run completes with a note marking which parts are unverified. This is
incidental to the key-less search work and carries no independent
significance.

### 2. Doubao support (new)

Doubao is absent from upstream in its entirety, so the whole chain is new code
rather than a repair: the WebChat target registration, the preferences UI
entry, the dispatch path for DOM-captured targets, and the browser-side
`doubao_adapter.js`.

Because doubao.com changes its markup frequently, the adapter does not bind to
a single fixed class name. It probes candidates in priority order and takes the
first node that is actually mounted and visible; when none is found it returns
a null value instead of throwing, so a failed probe costs one extraction rather
than the whole sync.

Issues resolved while building this chain:

- **A follow-up question returned the previous answer.** Doubao exposes no
  per-message identifier, and the first version of this adapter keyed messages
  on `data-testid`, a value shared by every user bubble, so a stale turn was
  read as the new one. Keys are now minted from each bubble's ordinal among its
  role, and a baseline is snapshotted at submit time and re-checked at both poll
  and emit time, so a turn that predates the submission is rejected.
- **Intermittent `Chat never exposed a user turn`.** A React remount can produce
  a new turn whose key collides with the baseline. Upstream's position-based
  fallback is guarded by `deepseekRequestObserved` and is therefore unreachable
  for any other site, so such cases fell through to a 30-second hard failure.
  The fallback is now available to all sites.
- **Images and links were dropped entirely.** Upstream's `htmlToMarkdown`
  returns alt text for images and discards the URL. Doubao's React markup also
  leaves `src` pointing at a 1×1 placeholder with the real URL in `data-src` or
  `srcset`, so candidates are probed in order of trustworthiness.
- **The bridge never takes window focus.** It does not raise a window, does not
  call `tabs.update({active:true})`, and does not restore a minimised window. A
  minimised-window check records a diagnostic only and can never block a
  submission.

---

## Installation

```bash
git clone https://github.com/Zhurou-Ye/llm-for-zotero-patches
cd llm-for-zotero-patches
python install.py
```

The installer writes the patched `.xpi` into the Zotero profile — detecting it
automatically, backing up the existing copy and updating `extensions.json` —
then extracts the browser extension and prints the exact directory to load.

Requirements: Python 3.9+, Zotero, and a Chromium-based browser. Node.js is
needed only to build from source or run the test suite.

Four steps remain manual, because Chrome does not permit programmatic
installation:

1. Start Zotero. The bridge depends on the local relay it provides.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
   and select the directory printed by the installer.
3. In Zotero, open **Preferences → llm-for-zotero**:
   - **Web search provider → Free engines only** — otherwise the search
     replacement is inactive.
   - Any provider card → **Auth mode → WebChat → Fetch Models → `www.doubao.com`**.
4. Open <https://www.doubao.com/chat/> and keep the tab open.

> **Quit Zotero before running the installer.** A running Zotero rewrites its
> profile on exit, which would overwrite what was just installed. The installer
> detects a running Zotero and refuses rather than terminating it, because
> forcing termination can lose unsaved notes.

Optional arguments:

```bash
python install.py --profile <path>   # specify a Zotero profile
python install.py --xpi-only          # install the add-on only
python install.py --ext-only          # install the browser extension only
```

---

## Building from source

The release ships a prebuilt `dist/patched-llm-for-zotero-3.9.10.9.xpi`. To
rebuild it:

```bash
cd zotero-patches
python apply.py --xpi "/path/to/llm-for-zotero.xpi"
```

Stock add-on locations:

- **Windows** — `%APPDATA%\Zotero\Zotero\Profiles\<profile>\extensions\zotero-llm@github.com.yilewang.xpi`
- **macOS** — `~/Library/Application Support/Zotero/Zotero/Profiles/<profile>/extensions/`
- **Linux** — `~/.zotero/zotero/<profile>/extensions/`

Verified against upstream **v3.9.9** and **v3.9.10**. `build_xpi.py` derives the
patched version from the upstream version (3.9.10 → 3.9.10.9) so that Zotero
does not treat the build as a downgrade.

Each patch script fails with the specific anchor it could not find, so an
incompatible upstream release is reported rather than silently producing a
partially patched package.

<details>
<summary>Build requirements</summary>

Node.js is used for `node --check` syntax validation of the output. When Node is
absent this degrades to a warning rather than an abort; set
`SYNC_ZOTERO_NODE=/path/to/node` to point at a specific interpreter.
</details>

---

## Tests

```bash
npm install      # installs linkedom, a test-only dependency
python run-tests.py
```

The suite requires no Zotero, no browser and no network access. Current
status: **8 suites, 218 assertions, all passing**.

| Suite | Asserts against |
|---|---|
| `zotero-patches/tests/test_search_loop.js` | the ledger, duplicate detection and budget block, extracted from the shipped bundle |
| `zotero-patches/tests/test_segment_stall.js` | the segment-stall guard, extracted from the shipped bundle |
| `zotero-patches/tests/test_readme_claims.js` | every technical claim in this document, plus the presence of each patch in the shipped artefact |
| `browser-extension/tests/verify_doubao_focus_and_completion.js` | the real `content_script.js` — window focus, turn identity, completion detection |
| `browser-extension/tests/verify_doubao_userturn_binding.js` | the real `content_script.js` — user-turn binding and fallback |
| `browser-extension/tests/verify_doubao_media.js` | the real `content_script.js` — image and link extraction |
| `browser-extension/tests/legacy/test_doubao_adapter.js` | the real `doubao_adapter.js` |
| `browser-extension/tests/legacy/test_gemini_upload.js` | the real `gemini_adapter.js` |

Tests extract functions from the real sources and execute them rather than
matching source text, so a refactor cannot produce a false pass. The
add-on-side tests read the bundle out of `dist/*.xpi` themselves; an explicit
path can also be passed:

```bash
node zotero-patches/tests/test_search_loop.js /path/to/llmforzotero.js
```

<details>
<summary>Network tests and live probes</summary>

`browser-extension/tests/legacy/e2e_search_test.js` performs real network
searches. It is excluded from the offline suite and run separately.

`browser-extension/tests/probe_doubao_media.js` captures live DOM samples,
dumping the page's `data-testid` vocabulary and image candidate carriers
read-only.
</details>

---

## Repository layout

```
install.py                      Installer (cross-platform, auto-detects the profile)
run-tests.py                    Runs the whole offline suite
package.json                    Test dependencies (linkedom, test-only)
dist/                           Prebuilt .xpi (AGPL-3.0, see NOTICE.md)

zotero-patches/                 Add-on side
  apply.py                      Build entry point
  patches/
    patch_webaccess.py          Key-less multi-engine search, three-mode provider switch
    patch_search_quality.py     Query cleanup, quality reranking, body-text enrichment
    patch_search_loop.py        Per-run ledger, rewrite detection, hard budget
    patch_agent_segment.py      Segment stall guard
    patch_doubao_target.py      Registers Doubao in WEBCHAT_TARGETS
    patch_doubao_ui.py          Doubao icon, CSS rule and iconModifier entry
    patch_doubao_dispatch.py    Routes DOM-captured targets to dispatch
    patch_doubao_composer.py    composerFound as an advisory signal only
    patch_relay_debug.py        Exposes extension state on /debug
    patch_target_switch.py      Publishes the target before pre-flight
    nodepath.py                 Cross-platform Node discovery
  tests/
    bundle_source.js            Locates and unpacks the patched bundle
    test_search_loop.js         Ledger, duplicate detection, budget
    test_segment_stall.js       Segment stall guard
    test_readme_claims.js       Every technical claim in this document

browser-extension/              Browser side (Apache-2.0, derived from sync-for-zotero)
  doubao_adapter.js              New file: the Doubao adapter
  gemini_adapter.js              Tiered fallback for Gemini's hidden file input
  tests/
    verify_*.js                  129 assertions against the real content_script.js
    legacy/                      Adapter tests requiring linkedom, plus network e2e
```

---

## Limitations

1. **Key-less search depends on HTML scraping.** A Bing or 360 redesign breaks
   the parser; engine fallback only reduces the risk. Measured from a mainland
   network: DuckDuckGo is unreachable, Mojeek returns 403, Baidu and Sogou
   return redirect pages. Bing (three domains) and 360 are the engines that
   work in practice.
2. **`maxResults` is capped at 10.** The limit comes from the add-on's own tool
   definition and is independent of the backend, so a paid Tavily key does not
   lift it.
3. **The WebChat channel has no function calling and no streaming.** The
   `web_search` replacement is therefore inert under Doubao, which relies on
   Doubao's own web access.
4. **Doubao CDN images may be hotlink-protected.** Notes store image URLs; if an
   image does not render in Zotero, the cause is the CDN's referer policy rather
   than image loss in this package. Storing images as attachments would require
   the `generatedImages` path and a change to the relay protocol.
5. **Patch anchors are tracked to v3.9.10.** A newer upstream release may
   require adjustments.

---

## License

Three licences apply to disjoint parts of this repository. See
[NOTICE.md](NOTICE.md) for the full attribution.

| Scope | Licence |
|---|---|
| `install.py`, `zotero-patches/**` — original work here | MIT, [LICENSE-MIT.txt](LICENSE-MIT.txt) |
| `dist/*.xpi` — a derivative of llm-for-zotero | **AGPL-3.0** |
| `browser-extension/**` — a derivative of sync-for-zotero | **Apache-2.0**, see `LICENSE` and `CHANGES.md` in that directory |

GitHub labels this repository **Other** (`NOASSERTION`). That is correct rather
than a misconfiguration: three different licences apply, GitHub's detection can
only select one, and hard-coding any of them would misinform users. The table
above is authoritative.

Redistributing the patched `.xpi` is compliant because this repository provides
the complete build scripts, satisfying the AGPL source-availability
requirement. The patch scripts contain only string anchors and replacement
logic and read the user's own copy of the official add-on at build time; no
upstream source is committed here.
