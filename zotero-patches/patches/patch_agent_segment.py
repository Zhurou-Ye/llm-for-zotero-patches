# -*- coding: utf-8 -*-
"""
Stage-4 patch: stop the agent from being killed mid-research.

Symptom reported by the user:

    Agent stopped after segment 3 produced no new successful tool result.
    The completed transcript was saved; narrow or redirect the request before continuing.

Second symptom, the same root cause from the outside:

    ...我找到了一些论文，但还没有找到所有提到的论文。让我继续搜索更多具体的论文
    ... and then the exact same "found some papers but not all of them" block
        is rendered again, segment after segment.  (The scroll-wheel effect.)

Mechanism.  The agent loop is organised in segments.  Each segment runs up to
MAX_AGENT_ROUNDS model steps, then takes the tool records produced inside that
segment and maps each one to a progress fingerprint of shape
``{name, effect, input, content}``.  Fingerprints already seen in *earlier*
segments live in ``seenProgressFingerprints``.  If a segment produces nothing
new, the loop does not merely pause - it terminates the whole run as **failed**:

    if (!newFingerprints.length) {
      const finalText = currentAnswerText || `Agent stopped after segment ...`;
      return await completeRun(finalText, "failed");
    }

That is why a literature question dies.  Retrieval *is* the tool output: once
the free-web providers (or Tavily) have served their fixed handful of arXiv
pages, a reworded search returns byte-identical content, the fingerprint is
already in the set, and one segment later the run is thrown away.  The
half-finished text the model was typing is dropped with it, which the user
perceives as "it kept showing the same thing and then it broke".

What this patch changes (inside the agent loop only, nothing else):

  A. a stall is no longer fatal.  After the first segment with no new
     progress the loop appends one explicit wrap-up instruction to the model
     input and starts a new segment, so the model can answer from the
     material it already has.
  B. two consecutive stalls finish the run as ``completed`` and hand back
     ``currentAnswerText`` (with a short provenance note) instead of failing.
     The old "narrow or redirect the request" sentence is only used when
     there is genuinely no answer text to hand back.
  C. both events are logged through ``fwaDebug`` so the loop's behaviour is
     diagnosable from the Debug Output pane.

Run AFTER patch_search_quality.py and patch_search_loop.py.  Idempotent.
"""
import io
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, HERE)
import nodepath  # noqa: E402  (portable `node --check` lookup)
def _resolve(relative):
    """Locate the extracted add-on bundle.

    Order: command line arg, ZOTERO_SRC, ZOTERO_WORKDIR, script-relative.  The
    repo's apply.py runs the patches with ZOTERO_WORKDIR set to the scratch
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
    candidates.append(os.path.join(HERE, "zotero-llm-src", "xpi", "content",
                                   "scripts", "llmforzotero.js"))
    candidates.append(os.path.join(HERE, "..", "..", "zotero-dev", "zotero-llm-src",
                                   "xpi", "content", "scripts", "llmforzotero.js"))
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return candidates[0]

SRC = _resolve("script")
MARKER = "SEGMENT STALL PATCH"

# --------------------------------------------------------------------------
# A. counters next to the existing segment counter.
# --------------------------------------------------------------------------
# 3.9.10 inserts a `settledAtSegmentStart` bookkeeping line between
# `streamRecoveryUsed` and the fingerprint set, so the whole four-line block has
# to be matched with a regex instead of a literal.
COUNTERS_RE = re.compile(
    r'(?P<ind>[ ]*)let streamRecoveryUsed = false;\n'
    r'(?:(?P=ind)let settledAtSegmentStart = [\s\S]*?\n)?'
    r'(?P=ind)const seenProgressFingerprints = /\* @__PURE__ \*/ new Set\(\);'
)


def _counters_replacement(match):
    ind = match.group("ind")
    return (
        "%slet streamRecoveryUsed = false;\n" % ind
        + ("%slet settledAtSegmentStart = 0;\n" % ind
           if "settledAtSegmentStart" in match.group(0)
           else "")
        + "%slet fwaStalledSegments = 0;\n" % ind
        + "%slet fwaStallInstructionAdded = false;\n" % ind
        + "%sconst seenProgressFingerprints = /* @__PURE__ */ new Set();" % ind
    )


# --------------------------------------------------------------------------
# B. the stall itself: one grace segment, then hand back what we have.
# --------------------------------------------------------------------------
# Upstream 3.9.10 hardened this branch rather than fixing it: the condition
# grew a `&& !settledNewTargets` escape hatch, the fallback text moved from
# `currentAnswerText` to `uncommittedAnswerText()`, and completeRun() grew a
# third `reason` argument. The failure semantics are unchanged, so the patch is
# still needed -- it just has to bind to whichever shape it finds.
STALL_RE = re.compile(
    r'(?P<ind>[ ]*)if \(!newFingerprints\.length(?P<cond>(?: && !settledNewTargets)?)\) \{\n'
    r'(?P=ind)  const finalText = (?P<text>[\w]+)(?P<call>\(\))? \|\| `Agent stopped after segment \$\{segment\} produced no new successful tool result\. The completed transcript was saved; narrow or redirect the request before continuing\.`;\n'
    r'(?P=ind)  return await completeRun\(\n'
    r'(?P=ind)    finalText,\n'
    r'(?P=ind)    "failed"(?P<reason>(?:,\n(?P=ind)    "[a-z_]+")?)\n'
    r'(?P=ind)  \);\n'
    r'(?P=ind)\}'
)


STALL_TEMPLATE = '''{ind}if (!newFingerprints.length{cond}) {{
{ind}  // === BEGIN SEGMENT STALL PATCH ===
{ind}  // A stall must not destroy a half-finished answer.  Retrieval
{ind}  // tools return content, so once the provider has served its
{ind}  // handful of pages every further search produces an identical
{ind}  // fingerprint - the loop read that as "no progress" and failed
{ind}  // the whole run.  Give the model one wrap-up segment first, then
{ind}  // answer from what was already gathered.
{ind}  fwaDebug("segment " + segment + " produced no new tool progress");
{ind}  fwaStalledSegments += 1;
{ind}  if (fwaStalledSegments >= 2) {{
{ind}    const stalledFinalText = {text}
{ind}      ? {text} + "\\n\\n[Stopped here: the last " + fwaStalledSegments
{ind}        + " agent segments produced no new information. This answer only reflects "
{ind}        + "the sources gathered above.]"
{ind}      : `Agent stopped after segment ${{segment}} produced no new successful tool result. The completed transcript was saved; narrow or redirect the request before continuing.`;
{ind}    return await completeRun(stalledFinalText, {text} ? "completed" : "failed"{reason});
{ind}  }}
{ind}  if (!fwaStallInstructionAdded) {{
{ind}    fwaStallInstructionAdded = true;
{ind}    messages.push({{
{ind}      role: "user",
{ind}      content: "WRAP UP NOW. The last agent segment produced no new information: every tool you invoked either repeated a result you already have or failed. Do not call web_search or any other information-gathering tool again. Using only what you already have, write the final answer to the user's question now. Where an item could not be verified, say so plainly under a short 'not found' heading instead of searching again."
{ind}    }});
{ind}  }}
{ind}  await emit2({{
{ind}    type: "status",
{ind}    text: `Segment ${{segment}} produced no new information; asking the model to wrap up`
{ind}  }});
{ind}  continue;
{ind}  // === END SEGMENT STALL PATCH ===
{ind}}}'''


def _stall_replacement(match):
    # The upstream expression is either a bare value (`currentAnswerText`) or a
    # call (`uncommittedAnswerText()`). Reuse the call suffix verbatim: writing
    # our own "()" on top of a captured `foo()` produces `foo()()`, which is a
    # runtime TypeError in the add-on, not a build-time failure.
    text = match.group("text") + (match.group("call") or "")
    return STALL_TEMPLATE.format(
        ind=match.group("ind"),
        cond=match.group("cond"),
        text=text,
        reason=match.group("reason") or "",
    )

def main():
    if not os.path.exists(SRC):
        sys.exit("FAIL: bundle not found -> %s" % SRC)

    with io.open(SRC, encoding="utf-8", newline="") as fh:
        code = fh.read()

    if "SEGMENT STALL PATCH" in code:
        print("already patched (marker present) - aborting to avoid double-application")
        return

    replacements = (
        (COUNTERS_RE, _counters_replacement, "stall counters"),
        (STALL_RE, _stall_replacement, "segment stall: wrap up instead of failing"),
    )

    for pattern, build, label in replacements:
        found = pattern.findall(code)
        if not found:
            sys.exit("FAIL: anchor not found -> %s" % label)
        if len(found) != 1:
            sys.exit("FAIL: anchor not unique (%d) -> %s" % (len(found), label))
        code = pattern.sub(build, code, count=1)
        print("  ~ %s" % label)

    with io.open(SRC, "w", encoding="utf-8", newline="") as fh:
        fh.write(code)

    nodepath.syntax_check(SRC, label="llmforzotero.js")
    print("  + node --check passed")
    print("patched OK")

if __name__ == "__main__":
    main()
