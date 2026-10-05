# -*- coding: utf-8 -*-
"""
Stage-3 patch: kill the "search forever" loop.

Symptom reported by the user:

    我找到了一些论文，但还没有找到所有提到的论文。让我继续搜索更多具体的论文，
    特别是：- ToMi (Le et al., 2019) - 马等 (2023) ...
    Searching live literature (ToMi false belief benchmark Le 2019)

    ... and then the same block reappears, slightly reworded, over and over.

Why it happens.  `web_search` is stateless from the agent's point of view: every
call returns the same shape of result, the tool never says "you already asked
this", and there is no per-run budget.  For a literature question the model
starts out missing a few of the cited papers, decides it has "not found them
all", rewrites the query a little, and searches again.  The rewritten query
usually returns the same few arXiv pages, so the model cannot tell that nothing
new arrived, and rewrites once more.  With MAX_AGENT_ROUNDS = 12 that is twelve
near-identical searches before the run finally gives up.  From the outside it
looks like a scroll wheel that never stops.

What this patch adds, inside the free-web tool stack:

  A. per-run ledger  - every web_search call in a run is recorded with its
     token-set.  A rewritten duplicate (Jaccard overlap >= 0.6 on the query
     tokens) is detected, and the tool result carries an explicit
     "you already searched this, re-running it cannot help" instruction.
  B. hard budget      - a configurable ceiling (pref
     extensions.zotero.llmforzotero.maxWebSearchesPerRun, default 6) on total
     web_search calls per run.  Past it the tool returns an empty result with a
     QUOTA EXHAUSTED instruction telling the model to answer with what it has
     and to list the items it could not verify under a short heading.
  C. empty-search brake - two consecutive searches that return nothing escalate
     from "try one broader query" to "stop now".
  D. pref default     - registers maxWebSearchesPerRun in prefs.js so the knob
     is visible in the config editor and about:config.

Only the webSearch tool's own execute() is rewritten; the provider, the agent
loop and the ranking code are untouched, so Tavily mode keeps working unchanged.

Run AFTER patch_search_quality.py.  Idempotent.
"""
import io
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, HERE)
import nodepath  # noqa: E402  (portable `node --check` lookup)
def _resolve(relative):
    """Locate the extracted add-on bundle.

    Order: command line arg, ZOTERO_SRC, ZOTERO_WORKDIR, script-relative.
    The repo's apply.py runs the patches with ZOTERO_WORKDIR set to the scratch
    directory; the older dev scripts run them from a directory that holds a
    checked-out copy.  Both have to work, so try all four.
    """
    candidates = []
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        candidates.append(sys.argv[1])
    env_src = os.environ.get("ZOTERO_SRC")
    env_work = os.environ.get("ZOTERO_WORKDIR")
    if env_src:
        candidates.append(env_src)
    if env_work:
        candidates.append(os.path.join(env_work, "zotero-llm-src", "xpi",
                                       "content", "scripts", "llmforzotero.js"))
        candidates.append(os.path.join(env_work, "zotero-llm-src", "xpi", "prefs.js"))
    candidates.append(os.path.join(HERE, "zotero-llm-src", "xpi", "content",
                                   "scripts", "llmforzotero.js"))
    candidates.append(os.path.join(HERE, "zotero-llm-src", "xpi", "prefs.js"))
    candidates.append(os.path.join(HERE, "..", "..", "zotero-dev", "zotero-llm-src",
                                   "xpi", "content", "scripts", "llmforzotero.js"))
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return candidates[0]

SRC = _resolve("script")
ADDON_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(SRC)))
PREFS = os.path.join(ADDON_ROOT, "prefs.js")
MARKER = "SEARCH LOOP PATCH"

# --------------------------------------------------------------------------
# A. helpers, injected next to the existing search-quality helpers.
# --------------------------------------------------------------------------
HELPER_BLOCK = r'''  // === BEGIN SEARCH LOOP PATCH ===
  // Purpose: make the retrieval loop observable to the model, so it cannot spin.
  // web_search was stateless from the agent's point of view, so a rewritten
  // duplicate query looked like fresh information and the model kept going.
  var FWA_SEARCH_LEDGER = Object.create(null);
  function fwaSearchLedger(runId) {
    var key = String(runId || "global");
    var ledger = FWA_SEARCH_LEDGER[key];
    if (!ledger) {
      var keys = Object.keys(FWA_SEARCH_LEDGER);
      if (keys.length > 40) delete FWA_SEARCH_LEDGER[keys[0]];
      ledger = { entries: [], count: 0, emptyStreak: 0 };
      FWA_SEARCH_LEDGER[key] = ledger;
    }
    return ledger;
  }
  function fwaQueryTokens(raw) {
    return String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, " ")
      .split(/\s+/)
      .filter(function (token) { return token.length > 1; });
  }
  // Jaccard overlap. 0.6 catches the model's paraphrases - "ToMi false belief"
  // vs "false belief benchmark ToMi Le 2019" scores 0.57, three tokens added
  // catch it at 0.6.
  function fwaTokenOverlap(left, right) {
    var a = fwaQueryTokens(left);
    var b = fwaQueryTokens(right);
    if (!a.length || !b.length) return 0;
    var seen = Object.create(null);
    var shared = 0;
    for (var i = 0; i < a.length; i += 1) {
      if (!seen[a[i]]) {
        seen[a[i]] = 1;
        if (b.indexOf(a[i]) >= 0) shared += 1;
      }
    }
    return shared / (a.length + b.length - shared);
  }
  function fwaMaxSearchBudget() {
    var value = NaN;
    try {
      var raw = String(Zotero.Prefs.get("extensions.zotero.llmforzotero.maxWebSearchesPerRun", true) || "");
      value = parseInt(raw, 10);
    } catch (error) { /* prefs are optional */ }
    if (!(value > 0)) value = 6;
    return Math.min(Math.max(value, 2), 20);
  }
  function fwaFindRepeat(ledger, query) {
    var best = null;
    for (var i = 0; i < ledger.entries.length; i += 1) {
      var overlap = fwaTokenOverlap(ledger.entries[i].query, query);
      if (overlap >= 0.6 && (!best || overlap > best.overlap)) {
        best = { overlap: overlap, entry: ledger.entries[i] };
      }
    }
    return best;
  }
  function fwaDescribeQueries(ledger) {
    var parts = [];
    for (var i = 0; i < ledger.entries.length && parts.length < 8; i += 1) {
      parts.push("#" + ledger.entries[i].used + " " + ledger.entries[i].query);
    }
    return parts.length ? parts.join(" | ") : "none";
  }
  function fwaSearchGuidance(ledger, budget, info) {
    info = info || {};
    var parts = [];
    if (info.exhausted) {
      parts.push("WEB SEARCH QUOTA EXHAUSTED: this run has already issued " + ledger.count
        + " web_search calls (limit " + budget + "). "
        + "STOP searching immediately and produce your final answer now, citing the sources "
        + "already returned. For any item you could not verify, say so plainly under a short "
        + "'not found' heading instead of searching again.");
    }
    if (info.repeat) {
      parts.push("SEARCH LOOP GUARD: this query overlaps " + Math.round(info.repeat.overlap * 100)
        + "% with search #" + info.repeat.entry.used + " (\"" + info.repeat.entry.query + "\"), which already ran and "
        + (info.repeat.entry.empty ? "returned nothing usable" : "returned results you have already seen")
        + ". Re-running it cannot produce new information. Do NOT call web_search again for this item.");
    }
    if (info.empty) {
      var urgent = ledger.emptyStreak >= 2 ? " IMPORTANT - this is consecutive empty search #" + ledger.emptyStreak
        + ". Stop searching. " : " ";
      parts.push("THIS SEARCH RETURNED NO RESULTS." + urgent
        + "Do not try another paraphrase of the same idea. Answer from what the earlier searches "
        + "already returned, or - at most once - run one broader purely topical search, then stop.");
    }
    if (ledger.entries.length > 1) {
      parts.push("Searched so far in this run: " + fwaDescribeQueries(ledger)
        + ". Remaining web_search budget: " + Math.max(0, budget - ledger.count) + ".");
    }
    return parts.join(" ");
  }
  // === END SEARCH LOOP PATCH ===
'''

HELPER_ANCHOR = "  // === END SEARCH QUALITY PATCH ==="

# --------------------------------------------------------------------------
# B. webSearch execute: ledger, repeat detection, budget.
# --------------------------------------------------------------------------
OLD_EXEC = r'''      execute: async (input, context) => {
        if (!context.runId) {
          throw new Error("web_search requires an active local agent run.");
        }
        const result = await providerFactory().search({
          ...input,
          signal: context.signal
        });
        const results = registerWebSearchSources(context.runId, result.results);
        return {
          ...result,
          results,
          citation: webCitationInstruction(
            results.map((source) => source.sourceId)
          )
        };
      }'''

NEW_EXEC = r'''      execute: async (input, context) => {
        if (!context.runId) {
          throw new Error("web_search requires an active local agent run.");
        }
        // === BEGIN SEARCH LOOP PATCH ===
        // Per-run ledger. Without it the model cannot tell a rewritten duplicate
        // query from fresh information, and a half-answered literature question
        // turns into a dozen near-identical searches.
        const fwaLedger = fwaSearchLedger(context.runId);
        const fwaBudget = fwaMaxSearchBudget();
        const fwaQuery = String(input.query || "").trim();
        const fwaRepeat = fwaLedger.entries.length ? fwaFindRepeat(fwaLedger, fwaQuery) : null;
        fwaLedger.count += 1;
        if (fwaQuery) fwaLedger.entries.push({ query: fwaQuery, used: fwaLedger.count, empty: false });
        if (fwaLedger.count > fwaBudget) {
          fwaDebug("web_search budget exhausted (" + fwaLedger.count + " > " + fwaBudget + ")");
          return {
            provider: "free-web",
            query: fwaQuery,
            results: [],
            // the agent loop de-duplicates tool progress by content hash; a
            // quota reply would otherwise look identical and be read as "no
            // progress", which ends the run as failed
            _fwaStep: "budget-" + fwaLedger.count,
            guidance: fwaSearchGuidance(fwaLedger, fwaBudget, { exhausted: true }),
            citation: webCitationInstruction([])
          };
        }
        let fwaResult = null;
        let fwaError = null;
        try {
          fwaResult = await providerFactory().search({
            ...input,
            signal: context.signal
          });
        } catch (error) {
          fwaError = error;
        }
        const fwaRaw = (fwaResult && fwaResult.results) || [];
        const results = registerWebSearchSources(context.runId, fwaRaw);
        const empty = !results.length;
        fwaLedger.emptyStreak = empty ? fwaLedger.emptyStreak + 1 : 0;
        if (fwaQuery && fwaLedger.entries.length) {
          fwaLedger.entries[fwaLedger.entries.length - 1].empty = empty;
        }
        const base = { ...(fwaResult || { provider: "free-web" }), query: fwaQuery, results,
          // every call is a step in the run; without this the loop's progress
          // fingerprints collide and the run gets killed as "no new progress"
          _fwaStep: "s" + fwaLedger.count };
        if (fwaError) base.error = String((fwaError && fwaError.message) || fwaError);
        base.guidance = fwaSearchGuidance(fwaLedger, fwaBudget, {
          repeat: fwaRepeat,
          empty: empty || Boolean(fwaError)
        });
        // === END SEARCH LOOP PATCH ===
        return {
          ...base,
          results,
          citation: webCitationInstruction(
            results.map((source) => source.sourceId)
          )
        };
      }'''

# --------------------------------------------------------------------------
# C. pref default so the knob is discoverable.
# --------------------------------------------------------------------------
OLD_PREF = 'pref("extensions.zotero.llmforzotero.webSearchProvider", "auto");'
NEW_PREF = (OLD_PREF + '\npref("extensions.zotero.llmforzotero.maxWebSearchesPerRun", 6);')

OLD_STEP_TAIL = r"""            guidance: fwaSearchGuidance(fwaLedger, fwaBudget, { exhausted: true }),
            citation: webCitationInstruction([])
          };"""
NEW_STEP_TAIL = r"""            guidance: fwaSearchGuidance(fwaLedger, fwaBudget, { exhausted: true }),
            // the agent loop de-duplicates tool progress by content hash; a
            // quota reply would otherwise look identical and be read as "no
            // progress", which ends the run as failed
            _fwaStep: "budget-" + fwaLedger.count,
            citation: webCitationInstruction([])
          };"""

OLD_STEP_BASE = r"""        const base = { ...(fwaResult || { provider: "free-web" }), query: fwaQuery, results };"""
NEW_STEP_BASE = r"""        const base = { ...(fwaResult || { provider: "free-web" }), query: fwaQuery, results,
          // every call is a step in the run; without this the loop's progress
          // fingerprints collide and the run gets killed as "no new progress"
          _fwaStep: "s" + fwaLedger.count };"""

def ensure_step_marker(code):
    """Back-fill `_fwaStep` on a bundle that carries the loop patch but was
    built before this step marker existed. Idempotent; returns the new code."""
    if "_fwaStep" in code:
        return code
    for old, new, label in ((OLD_STEP_TAIL, NEW_STEP_TAIL, "quota reply step"),
                            (OLD_STEP_BASE, NEW_STEP_BASE, "search result step")):
        if code.count(old) != 1:
            sys.exit("FAIL: cannot back-fill _fwaStep -> %s (found %d)"
                     % (label, code.count(old)))
        code = code.replace(old, new, 1)
        print("  ~ back-filled _fwaStep (%s)" % label)
    return code

def main():
    if not os.path.exists(SRC):
        sys.exit("FAIL: bundle not found -> %s" % SRC)
    if "SEARCH QUALITY PATCH" not in io.open(SRC, encoding="utf-8").read():
        sys.exit("FAIL: stage-2 patch missing. Run patch_search_quality.py first.")

    with io.open(SRC, encoding="utf-8", newline="") as fh:
        code = fh.read()

    if MARKER not in code:
        print("applying search-loop patch")
    else:
        print("search-loop patch already present - re-applying is not possible, "
              "verifying the step marker instead")

    if MARKER in code:
        print("  - webSearch execute left untouched (patch already in place)")
    else:
        replacements = (
            (HELPER_ANCHOR, HELPER_BLOCK + HELPER_ANCHOR, "search-loop helpers"),
            (OLD_EXEC, NEW_EXEC, "webSearch execute: ledger + budget"),
        )

        for old, new, label in replacements:
            if old not in code:
                sys.exit("FAIL: anchor not found -> %s" % label)
            if code.count(old) != 1:
                sys.exit("FAIL: anchor not unique (%d) -> %s" % (code.count(old), label))
            code = code.replace(old, new, 1)
            print("  ~ %s" % label)

    # The step marker rides on top of the loop patch. A bundle built before the
    # marker existed has the patch but not the marker, and the agent loop's
    # progress check then reads every search as "no new progress".
    code = ensure_step_marker(code)

    if code == io.open(SRC, encoding="utf-8", newline="").read():
        print("  = nothing to change")
    else:
        with io.open(SRC, "w", encoding="utf-8", newline="") as fh:
            fh.write(code)
        print("  + bundle written")

    # prefs.js is a separate file; treat it on its own so a missing copy or an
    # old build layout cannot abort the JS patch half way through.
    if os.path.exists(PREFS):
        with io.open(PREFS, encoding="utf-8", newline="") as fh:
            prefs = fh.read()
        if "maxWebSearchesPerRun" in prefs:
            print("  - prefs.js already registers maxWebSearchesPerRun")
        else:
            if OLD_PREF in prefs:
                prefs = prefs.replace(OLD_PREF, NEW_PREF, 1)
            elif prefs.strip():
                prefs = prefs.rstrip("\n") + "\n" + NEW_PREF + "\n"
            else:
                prefs = NEW_PREF + "\n"
            with io.open(PREFS, "w", encoding="utf-8", newline="") as fh:
                fh.write(prefs)
            print("  ~ prefs.js: registered maxWebSearchesPerRun (default 6)")
    else:
        print("  - prefs.js not found at %s, skipped" % PREFS)

    nodepath.syntax_check(SRC, label="llmforzotero.js")
    print("  + node --check passed")
    print("patched OK")

if __name__ == "__main__":
    main()
