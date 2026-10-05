/**
 * Unit test for the segment-stall guard (patches/patch_agent_segment.py).
 *
 * The bug being guarded against:
 *
 *     Agent stopped after segment 3 produced no new successful tool result.
 *     The completed transcript was saved; narrow or redirect the request before continuing.
 *
 * The agent loop works in segments.  After each segment it hashes the tool
 * records produced inside it and throws those hashes into a cross-segment set.
 * If a segment yields nothing new the loop does not pause - it ends the run.
 * For a literature question that is fatal: retrieval *is* the tool output, so
 * once the provider has served its handful of arXiv pages every further
 * (reworded) search returns byte-identical content, the hash is already in
 * the set, and the half-written answer is discarded as a failure.
 *
 * This test lifts the exact stall block out of the patched bundle and drives
 * it with stubs, asserting that (1) a first stall hands the model a wrap-up
 * instruction and continues, (2) a second stall answers as "completed" with
 * the text already produced instead of failing, (3) the old "narrow or
 * redirect" sentence survives only when there is genuinely nothing to hand
 * back, and (4) the instruction is injected only once.
 *
 * Run:  node tests/test_segment_stall.js <path-to-llmforzotero.js>
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

/**
 * Pull the two stall counters out of the patched counter block.  In the bundle
 * they sit outside the segment loop, so they survive across segments; the test
 * has to reproduce that, otherwise every drive starts from zero and the
 * second-stall branch is unreachable.  Drop the declarations from the block
 * and declare them once in the harness instead.
 */
function extractCounters(code) {
  const start = code.indexOf("let fwaStalledSegments = 0;");
  if (start < 0) throw new Error("stall counters not found in bundle");
  const end = code.indexOf("const seenProgressFingerprints", start);
  return code.slice(start, end)
    .replace(/^\s*(?:let|var)\s+fwaStalledSegments\s*=\s*0;\s*$/m, "")
    .replace(/^\s*(?:let|var)\s+fwaStallInstructionAdded\s*=\s*false;\s*$/m, "");
}

/** Pull the `if (!newFingerprints.length) { ... }` block and neutralise it. */
function extractStallBody(code) {
  // Upstream 3.9.10 added a `&& !settledNewTargets` escape hatch to this very
  // condition, so matching the 3.9.9 text literally made the test throw
  // "stall block not found" on a correctly patched newer bundle. Accept the
  // condition with or without the extra clause.
  const pattern = /if \(!newFingerprints\.length(?: && !settledNewTargets)?\) \{/;
  const match = pattern.exec(code);
  if (!match) throw new Error("stall block not found in bundle");
  const head = match[0];
  const start = match.index;
  let depth = 0;
  let end = -1;
  for (let i = start + head.length - 1; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error("unbalanced stall block");
  const body = code.slice(start + head.length, end - 1);
  // the loop's `continue` becomes a sentinel the test can observe
  return body.replace(/^\s*continue;\s*$/m, 'return "continue";');
}

const counters = extractCounters(source);
const body = extractStallBody(source);

// The patch awaits completeRun, so the harness must be async.  The counters
// are declared once per context, exactly as the bundle declares them once per
// agent run, which is what lets a second stall be observed.
const harnessTemplate = (counters, body) => `
var fwaStalledSegments = 0;
var fwaStallInstructionAdded = false;
this.fwaStallState = () => ({ stalled: fwaStalledSegments, injected: fwaStallInstructionAdded });
this.fwaStallRun = async function (newFingerprints, currentAnswerText, segment,
                             messages, completeRun, emit2, fwaDebug) {
${counters}
  // Upstream 3.9.9 exposes the half-written answer as the local
  // \`currentAnswerText\`; 3.9.10 replaced it with an \`uncommittedAnswerText()\`
  // call. The patched block binds to whichever the bundle uses, so the harness
  // has to offer both names or the test only runs against one upstream.
  // (Declared as a function *expression* on a distinct local: naming the
  // binding the same as the function the block calls makes the call recurse
  // into itself.)
  var answerText = function () { return currentAnswerText; };
  var uncommittedAnswerText = answerText;
  if (!newFingerprints.length) {
${body}
  }
  return "fallthrough";
};`;

/** A fresh agent run: fresh counters, as in a real run of the loop. */
function makeRun() {
  const context = { console, String, JSON, Math, Object, Array, Boolean };
  vm.createContext(context);
  vm.runInContext(harnessTemplate(counters, body), context);
  return context;
}

const sandbox = makeRun();


/**
 * Drive one stall and report everything the block decided to do.
 * `context` defaults to the shared run; pass a fresh one to start a new run.
 *
 * Note on `result`: the second-stall branch is `return await completeRun(...)`,
 * so it resolves to whatever the stub returns rather than to the "continue"
 * sentinel. Callers assert on `outcome` for that branch.
 */
async function stall(state, context = sandbox) {
  const messages = [];
  const statusEvents = [];
  const debugLines = [];
  let outcome = null;
  const result = await context.fwaStallRun(
    state.newFingerprints, state.currentAnswerText, state.segment, messages,
    (text, status) => { outcome = { text, status }; },
    (event) => statusEvents.push(event),
    (message) => debugLines.push(message));
  return { result, messages, statusEvents, debugLines, outcome, state };
}

async function main() {

// --- replay the reported failure mode ----------------------------------------
console.log("\n[first stall: segment 3, half-written answer in hand]");
let s1 = await stall({
  newFingerprints: [],
  currentAnswerText: "ToM 评估的早期工作以 ToMi (Le et al., 2019) 为代表，它用…",
  segment: 3,
});
check("the first stall does not terminate the run", s1.result === "continue", "result=" + s1.result);
check("it injects exactly one wrap-up instruction",
  s1.messages.length === 1 && /WRAP UP NOW/.test(s1.messages[0].content),
  JSON.stringify(s1.messages));
check("the instruction forbids another search",
  /Do not call web_search/.test(s1.messages[0].content));
check("it tells the model to say what it could not verify",
  /not found/.test(s1.messages[0].content));
check("the run is still going, so nothing was completed yet", s1.outcome === null);
check("the UI is told why it stalled",
  s1.statusEvents.length === 1 && /wrap up/.test(s1.statusEvents[0].text),
  JSON.stringify(s1.statusEvents));
check("the stall is logged for the debug pane",
  s1.debugLines.length === 1 && /no new tool progress/.test(s1.debugLines[0]),
  JSON.stringify(s1.debugLines));

// --- the model wraps up, but the next segment is dry as well ------------------
console.log("\n[second stall: nothing new either]");
const s2 = await stall({
  newFingerprints: [],
  currentAnswerText: "ToM 评估的早期工作以 ToMi (Le et al., 2019) 为代表，它用…",
  segment: 4,
});
check("the second stall terminates the run", typeof s2.result !== "string" && s2.outcome !== null,
  "result=" + s2.result);
check("it completes rather than fails", s2.outcome && s2.outcome.status === "completed",
  s2.outcome && s2.outcome.status);
check("the already produced answer is handed back, not discarded",
  s2.outcome && s2.outcome.text.indexOf("ToMi (Le et al., 2019)") >= 0, s2.outcome && s2.outcome.text);
check("a provenance note explains why it stopped",
  s2.outcome && /Stopped here/.test(s2.outcome.text));
check("the user is no longer told to narrow the request",
  s2.outcome && s2.outcome.text.indexOf("narrow or redirect") < 0);
check("no second instruction is injected", s2.messages.length === 0);

// --- a stall with nothing to show --------------------------------------------
console.log("\n[second stall with no answer text at all]");
const s3 = await stall({ newFingerprints: [], currentAnswerText: "", segment: 2 });
check("still completes, but is marked failed", s3.outcome && s3.outcome.status === "failed",
  s3.outcome && s3.outcome.status);
check("falls back to the original explanation message",
  s3.outcome && /produced no new successful tool result/.test(s3.outcome.text) &&
  /narrow or redirect/.test(s3.outcome.text), s3.outcome && s3.outcome.text);
check("and adds no provenance note", s3.outcome && !/Stopped here/.test(s3.outcome.text));

// --- the normal path must be untouched ---------------------------------------
console.log("\n[progress present: the guard must stay quiet]");
// a fresh run: the counters must not have been carried over
const freshRun = makeRun();
const s4 = await stall({
  newFingerprints: ["web_search:s7"],
  currentAnswerText: "",
  segment: 1,
}, freshRun);
check("a segment with new progress is not stalled at all", s4.result === "fallthrough",
  "result=" + s4.result);
check("nothing was completed behind our back", s4.outcome === null);
check("no instruction was injected", s4.messages.length === 0);
check("a fresh run starts from a clean counter",
  freshRun.fwaStallState().stalled === 0 && freshRun.fwaStallState().injected === false,
  JSON.stringify(freshRun.fwaStallState()));

console.log("\n" + (failures ? failures + " FAILURE(S)" : "all assertions passed"));
process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
