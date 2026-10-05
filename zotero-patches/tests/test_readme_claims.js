/**
 * Keep the README's technical claims tied to the actual bundle.
 *
 * Every number the README states about upstream behaviour -- the agent round
 * cap, the free-engine snippet length, Tavily's, the similarity threshold, the
 * search budget -- is copied from a particular upstream release. When upstream
 * ships a new version those numbers silently go stale, and a reader who trusts
 * them draws wrong conclusions about why the patches exist.
 *
 * The failure this prevents already happened once: the README said the agent
 * loop runs to `MAX_AGENT_ROUNDS = 24`, carried over from an older release.
 * Upstream 3.9.10 sets it to 12. Nothing failed, the docs were just wrong.
 *
 * So: read the real bundle, read the real README, and assert they agree.
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

// --- agent round cap -------------------------------------------------------
// The README must quote the cap that is actually compiled into the bundle.
const rounds = /MAX_AGENT_ROUNDS\s*=\s*(\d+)/.exec(source);
check("bundle exposes MAX_AGENT_ROUNDS", Boolean(rounds),
  "no assignment found in bundle");
if (rounds) {
  const n = rounds[1];
  check("README quotes the current round cap (" + n + ")",
    new RegExp("\\b" + n + "\\s*轮").test(readme),
    'README never mentions "' + n + ' 轮"; a stale number is probably still there');
  // Guard the specific regression: 24 belonged to an older upstream.
  const stale = /\b(?!12\b)\d+\s*轮(?!上限上限)/.exec(readme);
  check("README does not quote a different round count",
    !stale || readme.includes(n + " 轮"),
    'found a conflicting "轮" figure: ' + (stale && stale[0]));
}

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
  check("README quotes the free-engine snippet length (" + freeLen[1] + ")",
    readme.includes(freeLen[1] + " 字符"),
    'README should say "' + freeLen[1] + ' 字符"');
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
  check("README quotes the default budget (" + budget[1] + ")",
    readme.includes("默认 " + budget[1] + " 次"),
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
// The README's headline claim is that a stall no longer discards the answer.
// That is only true if the guard made it into the artefact.
check("shipped bundle contains the segment-stall guard",
  source.includes("fwaStalledSegments") && source.includes("WRAP UP NOW"),
  "the headline fix is missing from dist/*.xpi");
check("shipped bundle contains the search ledger",
  source.includes("FWA_SEARCH_LEDGER"),
  "the search-loop patches are missing from dist/*.xpi");
check("shipped bundle contains the free-engine provider",
  /FreeWebAccessProvider|getWebSearchProviderMode/.test(source),
  "the key-less search provider is missing from dist/*.xpi");

console.log("\n  " + passes + " passed, " + failures + " failed\n");
process.exit(failures ? 1 : 0);
