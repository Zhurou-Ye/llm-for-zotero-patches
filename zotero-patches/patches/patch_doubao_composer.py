# -*- coding: utf-8 -*-
"""
Stage-7 patch: make the pre-flight composer check advisory for DOM targets.

Context:
  ``validateTargetCapabilityForDispatch`` rejects a dispatch when the
  extension's cached health report says ``composerFound: false``:

      "The Doubao extension cannot find the chat composer. Wait for the
       page to finish loading or reload the tab."

  The report is pushed by the browser extension every 10 s (heartbeat), so it
  is a *sampled* view of the tab: it can be stale while a React chat page is
  still mounting its input, or it can describe a different doubao tab than the
  one the user is looking at. Doubao's composer is a client-rendered
  ProseMirror node, so a "composer missing right now" sample says nothing
  about whether it will be there one second later.

  The dispatch path itself is already patient: the content script waits for
  the composer (``getComposerElement``, 10 s) and for the send control before
  it clicks. For DOM-capture targets the pre-flight therefore duplicates that
  wait with a *cached* answer and fails early.

What this patch does:
  For DOM-capture targets (doubao, gemini) the composer check is downgraded
  from "hard fail" to "advisory": dispatch proceeds as long as the tab is
  alive, the content script answers and the reported site/URL match. Network
  capture targets keep the strict check (their send path depends on the
  intercepted transport being wired to a real composer).
"""
import io
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nodepath  # noqa: E402  (portable `node --check` lookup)
_WORKDIR = os.environ.get("ZOTERO_WORKDIR") or HERE
SRC = os.path.join(_WORKDIR, "zotero-llm-src", "xpi", "content", "scripts",
                   "llmforzotero.js")

MARKER = "DOUBAO DOM-CAPTURE COMPOSER PATCH"

OLD = '''    if (!status.composerFound) {
      return `The ${target.label} extension cannot find the chat composer. Wait for the page to finish loading or reload the tab.`;
    }'''

NEW = '''    // DOUBAO DOM-CAPTURE COMPOSER PATCH: the health report behind
    // composerFound is sampled every 10 s and can lag a client-rendered chat
    // page (doubao mounts its ProseMirror input after the first paint). The
    // dispatch path waits for the composer itself, so for DOM-capture targets
    // this check is advisory instead of fatal. Network-capture targets keep
    // the strict check.
    const advisoryComposerTarget = target.answerCapture === "dom" || targetId === "gemini";
    if (!status.composerFound && !advisoryComposerTarget) {
      return `The ${target.label} extension cannot find the chat composer. Wait for the page to finish loading or reload the tab.`;
    }'''

def main():
    if not os.path.exists(SRC):
        sys.exit("FAIL: %s missing." % SRC)

    with io.open(SRC, encoding="utf-8", newline="") as fh:
        code = fh.read()

    if MARKER in code:
        print("already patched (doubao advisory composer check) - nothing to do")
        return

    if OLD not in code:
        sys.exit("FAIL: composer guard anchor not found")
    if code.count(OLD) != 1:
        sys.exit("FAIL: anchor not unique (%d occurrences)" % code.count(OLD))

    code = code.replace(OLD, NEW, 1)

    with io.open(SRC, "w", encoding="utf-8", newline="") as fh:
        fh.write(code)

    nodepath.syntax_check(SRC, label="llmforzotero.js")

    print("  + composer guard: DOM-capture targets treat composerFound as advisory")
    print("  + node --check passed")
    print("patched OK")

if __name__ == "__main__":
    main()
