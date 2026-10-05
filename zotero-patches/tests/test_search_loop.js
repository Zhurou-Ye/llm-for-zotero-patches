/**
 * Unit test for the search-loop guard (patches/patch_search_loop.py).
 *
 * The bug being guarded against: the agent finds 6 of 10 cited papers, decides
 * it "has not found them all", rewrites the query, searches again - and because
 * the rewritten query silently returns the same pages, it does it again. Eight
 * near-identical searches look like a stuck scroll wheel.
 *
 * This test pulls the helper block straight out of the patched bundle and runs
 * the exact query sequence a ToM literature question produces, asserting that
 * (1) a paraphrase is detected as a repeat, (2) a real change of topic is not,
 * (3) the budget is enforced, (4) empty searches escalate.
 *
 * Run:  node tests/test_search_loop.js <path-to-llmforzotero.js>
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { resolveBundle } = require("./bundle_source.js");
const resolved = resolveBundle(process.argv);
const source = resolved.source;
console.log("  bundle: " + resolved.origin);

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log("  PASS  " + name);
  } else {
    failures += 1;
    console.log("  FAIL  " + name + (detail ? "\n        " + detail : ""));
  }
}

function extractHelpers(code) {
  const start = code.indexOf("var FWA_SEARCH_LEDGER = Object.create(null);");
  if (start < 0) throw new Error("helper block not found in bundle");
  const end = code.indexOf("// === END SEARCH LOOP PATCH ===", start);
  return code.slice(start, end);
}

const sandbox = { console, Math, Object, String, Number, parseInt, JSON };
sandbox.Zotero = { Prefs: { get: () => "6" } };
vm.createContext(sandbox);
vm.runInContext(extractHelpers(source) +
  "\nthis.fwaSearchLedger=fwaSearchLedger;" +
  "this.fwaTokenOverlap=fwaTokenOverlap;" +
  "this.fwaFindRepeat=fwaFindRepeat;" +
  "this.fwaMaxSearchBudget=fwaMaxSearchBudget;" +
  "this.fwaSearchGuidance=fwaSearchGuidance;", sandbox);


check("bud defaults to 6 when the pref is absent", sandbox.fwaMaxSearchBudget() === 6);
sandbox.Zotero.Prefs.get = () => "9";
check("bud follows the pref (9)", sandbox.fwaMaxSearchBudget() === 9);
sandbox.Zotero.Prefs.get = () => "6";

// --- overlap behaviour -------------------------------------------------------
console.log("\n[overlap]");
const paraphrase = sandbox.fwaTokenOverlap(
  "ToMi false belief benchmark Le 2019",
  "false belief benchmark ToMi Le 2019 evaluation");
const same = sandbox.fwaTokenOverlap("theory of mind LLM", "theory of mind LLM");
const different = sandbox.fwaTokenOverlap("theory of mind dataset", "nginx reverse proxy config");
const chinese = sandbox.fwaTokenOverlap("逆水寒 方承意 是谁", "方承意 逆水寒 人物");
check("paraphrase scores >= 0.6 (paraphrase=" + paraphrase.toFixed(2) + ")",
  paraphrase >= 0.6);
check("identical query scores 1.0", same === 1, "same=" + same);
check("unrelated query scores 0", different === 0, "different=" + different);
check("chinese paraphrase scores >= 0.5 (chinese=" + chinese.toFixed(2) + ")",
  chinese >= 0.5);

// --- replay the ToM session --------------------------------------------------
// The reported session: 6 papers found of 10 cited, then "let me search more
// specifically" over and over.
console.log("\n[replay with the default budget of 6]");
const queries = [
  { q: "theory of mind evaluation LLM survey", hits: 8 },
  { q: "theory of mind benchmark LLM survey", hits: 7 },       // paraphrase of #1
  { q: "false belief task ToMi Le 2019", hits: 5 },
  { q: "ToMi false belief benchmark Le 2019", hits: 4 },       // paraphrase of #3
  { q: "Kosinski evaluating theory of mind tasks LLM", hits: 5 },
  { q: "FANToM Kim 2023 conversational theory of mind", hits: 6 },
  { q: "Ma et al 2023 theory of mind challenges dataset", hits: 0 },
  { q: "Ma et al theory of mind dataset 2023", hits: 0 },      // paraphrase of #7
  { q: "Ullman trivial alterations theory of mind", hits: 3 }  // genuinely new
];

function replay(runId, budget) {
  const state = sandbox.fwaSearchLedger(runId);
  const out = [];
  for (const item of queries) {
    const repeat = state.entries.length ? sandbox.fwaFindRepeat(state, item.q) : null;
    state.count += 1;
    state.entries.push({ query: item.q, used: state.count, empty: item.hits === 0 });
    if (state.count > budget) {
      out.push(sandbox.fwaSearchGuidance(state, budget, { exhausted: true }));
      continue; /* the tool short-circuits: no provider call at all */
    }
    /* mirror the real execute(): the empty streak is maintained there */
    state.emptyStreak = item.hits === 0 ? state.emptyStreak + 1 : 0;
    out.push(sandbox.fwaSearchGuidance(state, budget,
      { repeat: repeat, empty: item.hits === 0 }));
  }
  return out;
}

const g6 = replay("run-tom-1", 6);
check("the model wants 9 searches, the provider answers 6",
  g6.length === 9 && g6.filter((g) => /QUOTA EXHAUSTED/.test(g)).length === 3,
  "exhausted=" + g6.filter((g) => /QUOTA EXHAUSTED/.test(g)).length);
check("search #2 is flagged as a repeat of #1",
  /SEARCH LOOP GUARD/.test(g6[1]) && /#1/.test(g6[1]), g6[1]);
check("search #4 is flagged as a repeat of #3",
  /SEARCH LOOP GUARD/.test(g6[3]) && /#3/.test(g6[3]), g6[3]);
check("searches #1-#6 are served, #7 onward is blocked",
  g6.slice(0, 6).every((g) => !/QUOTA EXHAUSTED/.test(g)) &&
  g6.slice(6).every((g) => /QUOTA EXHAUSTED/.test(g)));
check("every response after the first carries a running budget reminder",
  g6.slice(1).every((g) => /Remaining web_search budget/.test(g)));
check("a genuinely different topic (#5, #6) is never blocked",
  !/SEARCH LOOP GUARD/.test(g6[4]) && !/SEARCH LOOP GUARD/.test(g6[5]));

// --- same session with a generous budget: the empty-search brake must fire ---
console.log("\n[replay with the budget raised to 20]");
const g20 = replay("run-tom-2", 20);
check("nothing is blocked - the brake is the budget, not the queries",
  g20.every((g) => !/QUOTA EXHAUSTED/.test(g)));
check("search #8 is flagged as a repeat of #7",
  /SEARCH LOOP GUARD/.test(g20[7]) && /#7/.test(g20[7]), g20[7]);
check("the repeat of an empty search is described as 'nothing usable'",
  /returned nothing usable/.test(g20[7]), g20[7]);
check("empty search #8 escalates after two in a row",
  /consecutive empty search #2/.test(g20[7]), g20[7]);
check("search #9 (new topic) is not flagged",
  !/SEARCH LOOP GUARD/.test(g20[8]), g20[8]);
check("a healthy search resets the empty streak",
  !/consecutive empty/.test(g20[8]));
check("the ledger lists what was already searched",
  /Searched so far/.test(g20[2]) && /#1/.test(g20[2]), g20[2]);

// --- the model asks one more time after the budget is gone ---------------------
console.log("\n[post-budget]");
const final = g6[8];
check("exhausted guidance orders an immediate final answer",
  /STOP searching/.test(final) && /not found/.test(final), final);

console.log("\n" + (failures ? failures + " FAILURE(S)" : "all checks passed"));
process.exit(failures ? 1 : 0);
