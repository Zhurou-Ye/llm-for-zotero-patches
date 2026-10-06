/**
 * Keep the README's technical claims tied to the actual code.
 *
 * Every claim the README makes about *upstream* behaviour has to be checked
 * against upstream, not against the patched bundle. Those are different files
 * with different values, and conflating them is how this file previously
 * shipped three false statements:
 *
 *   1. "the agent loop runs to MAX_AGENT_ROUNDS = 24" -- true of upstream
 *      v3.9.10, but patch_search_quality.py *lowers* it to 12. The old test
 *      read the patched bundle, saw 12, and demanded the README say 12 while
 *      the sentence was describing upstream. So the doc asserted a patched
 *      value as an upstream one.
 *   2. "Doubao renders as a blank card upstream" -- upstream has no Doubao at
 *      all. `WEBCHAT_TARGETS` holds exactly chatgpt/deepseek/gemini and the
 *      string "doubao" appears zero times in the v3.9.10 bundle.
 *   3. "upstream keys messages by data-testid" -- that was our own first
 *      Doubao adapter. Upstream's ChatGPT adapter uses
 *      `data-message-author-role` / `data-message-id`.
 *
 * Rule this file enforces: the README must not put a *number we can only read
 * out of the patched bundle* into a sentence about upstream, and must not
 * claim upstream has a feature it does not have.
 *
 * Run:  node tests/test_readme_claims.js
 */
const fs = require("fs");
const path = require("path");
const { resolveBundle } = require("./bundle_source.js");

const README = path.join(__dirname, "..", "..", "README.md");

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    console.log("  PASS  " + name);
  } else {
    failures += 1;
    console.log("  FAIL  " + name + (detail ? "  -> " + detail : ""));
  }
}

const resolved = resolveBundle(process.argv);
const source = resolved.source;
const readme = fs.readFileSync(README, "utf8");
console.log("  bundle: " + resolved.origin);
console.log("  readme: " + path.basename(README) + "\n");

// --- Doubao is absent upstream, present after patching -------------------
// This is the check that would have caught false statement #2. The target
// list is read out of the real bundle rather than trusted from the README.
const targetsBlock = /WEBCHAT_TARGETS\s*=\s*\[([\s\S]*?)\n\s*\];/.exec(source);
check("bundle exposes WEBCHAT_TARGETS", Boolean(targetsBlock),
  "no WEBCHAT_TARGETS array found in bundle");
if (targetsBlock) {
  const ids = [...targetsBlock[1].matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
  check("patched bundle registers Doubao as a webchat target",
    ids.includes("doubao"), "targets present: " + ids.join(", "));
  // Upstream ships exactly these three. Anything else in the patched list
  // must be something this project added, and the README has to say so.
  const upstreamIds = ["chatgpt", "deepseek", "gemini"];
  const added = ids.filter((id) => !upstreamIds.includes(id));
  check("only Doubao is added on top of upstream",
    added.every((id) => id === "doubao"),
    "unexpected extra targets: " + added.join(", "));
  check("upstream's three targets are all still present",
    upstreamIds.every((id) => ids.includes(id)),
    "targets present: " + ids.join(", "));
}

// The README must state that Doubao is new, not broken-but-existing. Matched
// against several wordings so the check keeps working when the prose is
// rewritten into a more formal register.
check("README says Doubao is absent upstream",
  /(没有豆包|不存在豆包|豆包.{0,6}不存在|无豆包|豆包.{0,8}(全新|新加)|absent from upstream|no Doubao)/i.test(readme),
  'README should say upstream has no Doubao at all (e.g. "Doubao is absent from upstream in its entirety")');

// Deliberately word-order agnostic. Upstream has no Doubao at all, so ANY
// suggestion that a Doubao entry exists there and is merely malformed is
// false. Matching on co-occurrence rather than on a fixed phrase means a
// rewrite into a different register cannot smuggle the claim back in.
const blankClaim = /(空白|blank|empty|broken|malformed|render[s]?\s+nothing)/i;
check("README does not claim a broken/blank Doubao card upstream",
  !(blankClaim.test(readme) && /(豆包|doubao)/i.test(readme)),
  'upstream has no Doubao card; remove any "blank/broken card" framing');
// The occurrence count is the load-bearing evidence for "Doubao is absent",
// so pin it. Upstream v3.9.10 and sync-for-zotero main both yield zero.
check("README states the Doubao occurrence count as zero",
  /(occurs?\s+\**0\s*\**\s*times|出现\s*\**0\s*\**\s*次|0\s*次)/i.test(readme),
  'README should state that "doubao" occurs 0 times in the upstream sources');
check("README does not quote a non-zero Doubao occurrence count",
  !/occurs?\s+\**[1-9]\d*\s*\**\s*times|出现\s*\**[1-9]\d*\s*\**\s*次/i.test(readme),
  "upstream contains no Doubao reference at all; the count must be 0");
check("README does not attribute data-testid keying to upstream",
  !/(原版|upstream).{0,20}(按|uses|keys on)\s*`?data-testid`?\s*(当身份|as (the )?identity)/i.test(readme),
  "data-testid keying was our own first adapter, not upstream's");

// --- agent round cap ------------------------------------------------------
// The patch changes this value, so reading it out of the patched bundle tells
// us nothing about upstream. Forbid the README from stating a round number as
// if it described upstream, and require the name instead.
const rounds = /MAX_AGENT_ROUNDS\s*=\s*(\d+)/.exec(source);
check("bundle exposes MAX_AGENT_ROUNDS", Boolean(rounds),
  "no assignment found in bundle");
const roundClaims = [...readme.matchAll(/(\d+)\s*轮/g)].map((m) => m[0]);
check("README states no round count as an upstream fact",
  roundClaims.length === 0,
  "found round-count claim(s): " + roundClaims.join(", ") +
    " -- upstream is 24 and the patch lowers it; do not quote either as upstream's");
check("README refers to MAX_AGENT_ROUNDS by name",
  readme.includes("MAX_AGENT_ROUNDS"),
  "name the constant instead of quoting a number that differs per build");

// --- free-engine snippet length ------------------------------------------
// patch_search_quality.py documents the measured snippet lengths in its
// header comment; the README quotes them. Both must agree.
const q = fs.readFileSync(
  path.join(__dirname, "..", "patches", "patch_search_quality.py"), "utf8");
const freeLen = /free engines\s+(\d+)/.exec(q);
const tavilyLen = /Tavily\s+(\d+)/.exec(q);
check("patch_search_quality documents both snippet lengths",
  Boolean(freeLen && tavilyLen));
if (freeLen && tavilyLen) {
  // "58 characters" in English prose, "58 字符" in Chinese. Accept either.
  const freeOk = new RegExp(freeLen[1] + "\\s*(characters|字符)").test(readme);
  check("README quotes the free-engine snippet length (" + freeLen[1] + ")",
    freeOk,
    'README should say "' + freeLen[1] + ' characters"');
  check("README quotes Tavily's snippet length (" + tavilyLen[1] + ")",
    readme.includes(tavilyLen[1]),
    'README should mention "' + tavilyLen[1] + '"');
}

// --- similarity threshold -------------------------------------------------
const loopPatch = fs.readFileSync(
  path.join(__dirname, "..", "patches", "patch_search_loop.py"), "utf8");
const sim = /overlap\s*>=\s*(0\.\d+)/.exec(loopPatch);
check("patch_search_loop declares a similarity threshold", Boolean(sim));
if (sim) {
  check("README quotes the same threshold (" + sim[1] + ")",
    readme.includes("≥ " + sim[1]) || readme.includes(">= " + sim[1]) ||
    readme.includes(sim[1]),
    'README should state the ' + sim[1] + " threshold");
}

// --- search budget default ------------------------------------------------
const budget = /maxWebSearchesPerRun,\s*default\s*(\d+)/.exec(loopPatch);
check("patch_search_loop declares a default budget", Boolean(budget));
if (budget) {
  // "default 6" in English prose, "默认 6 次" in Chinese. Accept either.
  const budgetOk = new RegExp("default\\s+" + budget[1] + "\\b").test(readme) ||
    new RegExp("默认\\s*" + budget[1] + "\\s*次").test(readme);
  check("README quotes the default budget (" + budget[1] + ")",
    budgetOk,
    'README should say the default is ' + budget[1]);
}

// --- upstream version coverage -------------------------------------------
// The README promises which upstream releases are verified.
const built = fs.readdirSync(path.join(__dirname, "..", "..", "dist"))
  .filter((n) => n.endsWith(".xpi"));
check("dist ships exactly one .xpi (no ambiguity for the installer)",
  built.length === 1, "found: " + built.join(", "));
if (built.length === 1) {
  const ver = /for-zotero-(\d+(?:\.\d+)+)\.xpi$/.exec(built[0]);
  check("shipped .xpi name carries its version", Boolean(ver), built[0]);
  if (ver) {
    check("README names the shipped build (" + ver[1] + ")",
      readme.includes(ver[1]),
      'README should reference ' + ver[1]);
  }
}

// --- the stall guard really is in the shipped bundle ----------------------
// The stall guard is an incidental fix we added while debugging our own free
// search provider, not a headline feature. It still has to be in the artefact
// when the README mentions it at all, and the README must not sell it as the
// package's main contribution.
check("shipped bundle contains the segment-stall guard",
  source.includes("fwaStalledSegments") && source.includes("WRAP UP NOW"),
  "the stall guard is missing from dist/*.xpi");
check("README does not advertise the stall guard as the main fix",
  !/最实质的修复|核心贡献|最大的贡献/.test(readme),
  'the stall guard was found while debugging our own patch; do not claim it as a contribution');
check("README ships only real fixes in the summary table",
  !/你会得到什么[\s\S]{0,600}检索卡住/.test(readme),
  'the summary table should list capabilities, not the debugging-time stall fix');
check("shipped bundle contains the search ledger",
  source.includes("FWA_SEARCH_LEDGER"),
  "the search-loop patches are missing from dist/*.xpi");
check("shipped bundle contains the free-engine provider",
  /FreeWebAccessProvider|getWebSearchProviderMode/.test(source),
  "the key-less search provider is missing from dist/*.xpi");

console.log("\n  " + passes + " passed, " + failures + " failed\n");
process.exit(failures ? 1 : 0);
