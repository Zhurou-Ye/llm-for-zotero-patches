/**
 * Regression suite for: "Chat never exposed a user turn matching the submitted
 * prompt, so delivery could not be verified."
 *
 * Root cause recap
 * ----------------
 * Doubao ships no per-message id, so turn keys are minted from the bubble's
 * ordinal among its role (`doubao-user-2`). That makes a key REPEATABLE: if
 * React re-mounts a bubble, or the conversation grows while the baseline
 * snapshot is being taken, the newly submitted turn can carry a key that is
 * ALREADY in the baseline. `conversationMessagesAfterBaseline` treats a known
 * key as proof the turn is old, drops it, and the pipeline concludes that no
 * user turn was ever exposed -- even though the prompt was delivered and the
 * answer was streaming.
 *
 * Two independent defects fed that outcome:
 *   1. key-diffing had no positional safety net (collectMessagesAfterBaseline);
 *   2. the position-based fallback was gated on `deepseekRequestObserved`, so
 *      no other site could ever reach it, and the assistant resolver was
 *      likewise DeepSeek-only -- a non-DeepSeek site that failed to bind a
 *      user turn could never report an answer at all.
 *
 * These tests pin the fixed behaviour. They are deliberately behavioural:
 * the helper is extracted and exercised against hand-built transcripts rather
 * than asserted via source-text matching, so a refactor cannot silently
 * reintroduce the bug while leaving the assertions green.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Resolve the extension directory relative to this test file, so the suite
// runs from a fresh clone instead of one developer's Desktop.
const EXT = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n[${title}]`);
}

// ---------------------------------------------------------------------------
// Minimal stand-in for webchat_shared.js, implementing only the two helpers
// collectMessagesAfterBaseline composes.
// ---------------------------------------------------------------------------
const shared = {
  normalizeComposerText: (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim(),
  hasMeaningfulAssistantText: (text) => String(text || "").replace(/\s+/g, " ").trim().length > 0,
  // Verbatim copy of the shipped implementation, so the test exercises the
  // real key-diff semantics rather than an optimistic paraphrase.
  conversationMessagesAfterBaseline(currentMessages, baselineMessages, baselineCount = 0) {
    const current = Array.isArray(currentMessages) ? currentMessages : [];
    const baseline = Array.isArray(baselineMessages) ? baselineMessages : [];
    const baselineKeys = new Set(
      baseline.map((m) => String((m && m.messageKey) || "")).filter(Boolean),
    );
    const messagesWithNewKeys = baselineKeys.size > 0
      ? current.filter((m) => {
        const key = String((m && m.messageKey) || "");
        return key && !baselineKeys.has(key);
      })
      : [];
    if (messagesWithNewKeys.length > 0) return messagesWithNewKeys;
    return current.slice(Math.max(0, Number(baselineCount) || 0));
  },
};

// ---------------------------------------------------------------------------
// Extract collectMessagesAfterBaseline + findMatchingUserTurn from the real
// source so we test shipped behaviour, not a copy that can drift.
// ---------------------------------------------------------------------------
function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in content_script.js`);
  let depth = 0;
  let i = src.indexOf("{", start);
  const open = i;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// wordJaccardSimilarity is referenced by findMatchingUserTurn; the tier-1/tier-2
// paths never reach it in these tests, but it must exist to be callable.
const sandbox = {
  shared,
  console: { warn() {}, log() {}, error() {} },
  wordJaccardSimilarity: () => 0,
};
const code = [
  extractFunction("collectMessagesAfterBaseline"),
  extractFunction("findMatchingUserTurn"),
].join("\n\n");
vm.createContext(sandbox);
vm.runInContext(`${code}\nthis.__collect = collectMessagesAfterBaseline;\nthis.__find = findMatchingUserTurn;`, sandbox);
const collect = sandbox.__collect;
const find = sandbox.__find;

const user = (messageKey, text) => ({ messageKey, role: "user", text, attachments: [] });
const assistant = (messageKey, text) => ({ messageKey, role: "assistant", text, attachments: [] });
const asTranscript = (messages) => ({ messages, count: messages.length });

// ---------------------------------------------------------------------------
section("1. the mixed case: key-diff returns non-empty but with no user turn");
// Establishes the premise of the whole bug -- and the shape that a naive
// `if (byKey.length > 0) return byKey` guard fails to catch. The assistant
// turn gets a fresh key, so key-diffing is non-empty, while the user turn's key
// collides with the baseline and is filtered out.
{
  const baseline = [user("doubao-user-0", "q1"), assistant("doubao-assistant-0", "a1")];
  const current = [
    user("doubao-user-0", "q1"),
    assistant("doubao-assistant-0", "a1"),
    user("doubao-user-0", "q2"),       // key collided with the baseline
    assistant("doubao-assistant-1", "a2"),
  ];
  const byKey = shared.conversationMessagesAfterBaseline(current, baseline, baseline.length);
  check(
    "key-diffing returns a NON-empty result for the mixed case",
    byKey.length > 0,
    `got ${byKey.length}`,
  );
  check(
    "...but that result contains no user turn at all",
    byKey.filter((m) => m.role === "user").length === 0,
    "premise broken: key-diff did surface a user turn, so this test no longer covers the bug",
  );
  // Demonstrate the pre-fix failure using the RAW shared helper, not find().
  // find() already routes through the fixed wrapper, so it can no longer
  // reproduce the bug -- asserting on it would silently pass forever.
  check(
    "the raw shared helper therefore yields zero user candidates (the original bug)",
    byKey.filter((m) => m.role === "user").length === 0,
  );
  // The regression guard proper: the wrapper must rescue it.
  const rescued = collect(asTranscript(current), baseline, baseline.length);
  check(
    "collectMessagesAfterBaseline rescues the mixed case",
    rescued.filter((m) => m.role === "user").length > 0,
    `got ${JSON.stringify(rescued.map((m) => m.role))}`,
  );
  const rebound = find(asTranscript(current), baseline.length, "q2", baseline);
  check(
    "...and findMatchingUserTurn then binds the new turn",
    rebound && rebound.text === "q2",
    `got ${rebound && rebound.text}`,
  );
}

// ---------------------------------------------------------------------------
section("1b. the all-collide case was never broken");
// Worth pinning, because it narrows where the wrapper is actually load-bearing.
// The shipped conversationMessagesAfterBaseline already falls back to
// `current.slice(baselineCount)` when key-diffing finds nothing, so an
// all-collide conversation was handled correctly before this change. Only the
// mixed shape needed the wrapper.
{
  const baseline = [user("doubao-user-0", "old question")];
  const current = [user("doubao-user-0", "old question"), user("doubao-user-0", "new question")];
  const byKey = shared.conversationMessagesAfterBaseline(current, baseline, baseline.length);
  check(
    "the shared helper already recovers via its own position fallback",
    byKey.length === 1 && byKey[0].text === "new question",
    `got ${JSON.stringify(byKey.map((m) => m.text))}`,
  );
  check(
    "the wrapper agrees with it (no behaviour change here)",
    collect(asTranscript(current), baseline, baseline.length).length === 1,
  );
}

// ---------------------------------------------------------------------------
section("2. the submitted turn is always recoverable");
// The user-visible failure. Any of these regressions brings back
// "Chat never exposed a user turn matching the submitted prompt".
{
  const cases = [
    {
      name: "new turn carries a fresh key",
      baseline: [user("doubao-user-0", "old")],
      current: [user("doubao-user-0", "old"), user("doubao-user-1", "new")],
    },
    {
      name: "new turn reuses a baseline key (React re-mount)",
      baseline: [user("doubao-user-0", "old")],
      current: [user("doubao-user-0", "old"), user("doubao-user-0", "new")],
    },
    {
      name: "baseline is empty (very first turn in a chat)",
      baseline: [],
      current: [user("doubao-user-0", "new")],
    },
    {
      name: "site exposes no keys at all",
      baseline: [{ role: "user", text: "old" }],
      current: [{ role: "user", text: "old" }, { role: "user", text: "new" }],
    },
    {
      name: "conversation grew while the baseline was captured",
      baseline: [user("doubao-user-0", "old")],
      current: [user("doubao-user-0", "old"), user("doubao-user-1", "new")],
      countOverride: 0,
    },
    {
      name: "MIXED: assistant key fresh, user key collided",
      baseline: [user("doubao-user-0", "old"), assistant("doubao-assistant-0", "a1")],
      current: [
        user("doubao-user-0", "old"),
        assistant("doubao-assistant-0", "a1"),
        user("doubao-user-0", "new"),
        assistant("doubao-assistant-1", "a2"),
      ],
    },
  ];
  for (const c of cases) {
    const found = collect(
      asTranscript(c.current),
      c.baseline,
      c.countOverride == null ? c.baseline.length : c.countOverride,
    );
    check(
      `collectMessagesAfterBaseline finds the new user turn: ${c.name}`,
      found.length > 0,
      `got ${JSON.stringify(found)}`,
    );
  }
}

// ---------------------------------------------------------------------------
section("3. findMatchingUserTurn binds the RIGHT turn, not merely any turn");
// The safety property. Widening the candidate set must never let an unrelated
// earlier question win, which is the exact bug class the ordinal key scheme
// was introduced to fix (second question answered with the first reply).
{
  const baseline = [user("doubao-user-0", "what is the capital of France")];
  const current = [
    user("doubao-user-0", "what is the capital of France"),
    user("doubao-user-1", "tell me about 方承意"),
  ];
  const found = find(asTranscript(current), baseline.length, "tell me about 方承意", baseline);
  check(
    "text match selects the second turn when keys are distinct",
    found && found.text === "tell me about 方承意",
    `got ${found && found.text}`,
  );

  // The collision case: the new turn's key equals the old turn's key. A
  // positional candidate list is now [old, new], so ONLY text matching can
  // pick the right one.
  const collided = [
    user("doubao-user-0", "what is the capital of France"),
    user("doubao-user-0", "tell me about 方承意"),
  ];
  const foundCollided = find(asTranscript(collided), baseline.length, "tell me about 方承意", baseline);
  check(
    "text match still selects the second turn when the key collides",
    foundCollided && foundCollided.text === "tell me about 方承意",
    `got ${foundCollided && foundCollided.text}`,
  );
}

// ---------------------------------------------------------------------------
section("4. a same-key single candidate is still accepted");
// Guards the tier-4 path: when the collision leaves exactly one candidate we
// must not demand a text match, or short prompts would be rejected.
{
  const baseline = [user("doubao-user-0", "old")];
  const current = [user("doubao-user-0", "old"), user("doubao-user-0", "完全不同的新问题")];
  const found = find(asTranscript(current), baseline.length, "完全不同的新问题", baseline);
  check("single new candidate is accepted", Boolean(found), `got ${found && found.text}`);
}

// ---------------------------------------------------------------------------
section("5. an empty prompt must not bind to an unrelated turn");
{
  const baseline = [user("doubao-user-0", "old")];
  const current = [user("doubao-user-0", "old"), user("doubao-user-1", "new")];
  const found = find(asTranscript(current), baseline.length, "", baseline);
  check("empty prompt takes the latest candidate (documented behaviour)", Boolean(found));
}

// ---------------------------------------------------------------------------
section("6. non-DeepSeek sites can reach the fallbacks");
// Defect 2. These assert on source structure because the gating lives in the
// polling loop, which is not unit-extractable -- but they are anchored on
// distinctive expressions so a comment mentioning them cannot satisfy them.
{
  check(
    "position fallback is no longer gated on deepseekRequestObserved",
    !/fallbackCandidates\.length > 0 && deepseekRequestObserved/.test(src),
    "the DeepSeek-only gate is still present",
  );
  check(
    "deliveryObserved combines a DeepSeek request with a fresh assistant turn",
    /deliveryObserved\s*=\s*\n?\s*deliveryObserved \|\| deepseekRequestObserved \|\| Boolean\(freshAssistantTurn\)/.test(src),
    "latching expression not found",
  );
  check(
    "the no-user-turn hard throw sits in the final else, after a deliveryObserved branch",
    /if \(fallbackCandidates\.length > 0 && deliveryObserved\)[\s\S]*?\} else if \(deliveryObserved\) \{[\s\S]*?\} else \{[\s\S]*?throw noUserTurnError;/.test(src),
    "the throw is not guarded by a preceding deliveryObserved branch",
  );
  check(
    "assistant resolver accepts the generic deliveryObserved signal",
    /\(SITE_ADAPTER\?\.siteId === "deepseek" && requestContext\) \|\| deliveryObserved/.test(src),
    "resolver is still DeepSeek-only",
  );
  check(
    "deliveryObserved is declared at function scope, not inside the deadline block",
    /let deliveryObserved = false;/.test(src),
    "missing function-scope declaration (would ReferenceError at the resolver)",
  );
  check(
    "no block-scoped shadowing const deliveryObserved remains",
    !/const deliveryObserved =/.test(src),
    "a `const deliveryObserved` shadows the outer let and breaks the read",
  );
}

// ---------------------------------------------------------------------------
section("7. the stale-turn guard is intact");
// The fix must not weaken the protection that stops a pre-submit reply from
// being delivered as this turn's answer.
{
  check(
    "isPreexistingAssistantTurn still gates the assistant resolver",
    /if \(assistantTurn && isPreexistingAssistantTurn\(assistantTurn\)\)/.test(src),
  );
  check(
    "discarding a stale turn is still recorded",
    /recordTurnDebug\("stale_assistant_turn_discarded"/.test(src),
  );
  check(
    "baselineAssistantKeys is still snapshotted at submit time",
    /const baselineAssistantKeys = new Set\(/.test(src),
  );
}

// ---------------------------------------------------------------------------
section("8. build id and syntax are current");
{
  check("CONTENT_SCRIPT_BUILD bumped", src.includes("cs-doubao-2026-10-04-1"), "build id not updated");
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  // This used to assert `version === "0.0.24"`, i.e. that our build was
  // *newer* than upstream. That encoded the wrong invariant: out-ranking the
  // official release is what made our build indistinguishable from it. The
  // product now carries its own name and its own version line, so the thing
  // worth asserting is that it never presents itself as the upstream product.
  check(
    "extension is not named after the upstream product",
    manifest.name !== "Sync for Zotero" &&
      manifest.action.default_title !== "Sync for Zotero" &&
      manifest.name === "Zotero LLM Bridge (Unofficial)",
    `name=${manifest.name}`,
  );
  check(
    "version is ours, not an upstream-dominating one",
    manifest.version === "0.1.0",
    `got ${manifest.version}`,
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
