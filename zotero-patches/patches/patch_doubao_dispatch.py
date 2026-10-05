# -*- coding: utf-8 -*-
"""
Stage-6 patch: let DOM-capture targets (doubao) actually finish dispatch.

Context:
  WEBCHAT_TARGETS declares doubao with ``answerCapture: "dom"`` (stage 3),
  because doubao is client-rendered and has no verified network capture
  contract. The browser extension follows that contract in reverse: for a DOM
  capture target its content script reports

      mainWorldInjected: !domCapture && (...)   -> false
      networkHookActive: !domCapture && (...)   -> false

  i.e. it *correctly* reports "no network bridge", because the answer is read
  from the rendered DOM instead.

  But the generic branch of ``validateTargetCapabilityForDispatch`` still
  demanded both flags to be true before it would hand a query to the
  extension, so every doubao delivery died with

      "The Doubao page network bridge is inactive."

  before it ever reached the tab. Gemini has its own dedicated branch that
  accepts DOM capture; doubao needs the same treatment in the generic path.

What this patch does:
  Only require the network bridge for targets that capture answers over the
  network. DOM-capture targets must still have a live composer and a matching
  tab, which is checked just above.
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

MARKER = "DOUBAO DOM-CAPTURE DISPATCH PATCH"

OLD = '''    if (!status.mainWorldInjected || !status.networkHookActive) {
      return `The ${target.label} page network bridge is inactive. Reload the chat tab and try again.`;
    }'''

NEW = '''    // DOUBAO DOM-CAPTURE DISPATCH PATCH: DOM-capture targets (doubao) report
    // mainWorldInjected/networkHookActive as false *by design*, because the
    // answer is scraped from the rendered DOM instead of a network bridge.
    // Only network-capture targets need the bridge to be alive.
    const domCaptureTarget = target.answerCapture === "dom" || targetId === "gemini";
    if (!domCaptureTarget && (!status.mainWorldInjected || !status.networkHookActive)) {
      return `The ${target.label} page network bridge is inactive. Reload the chat tab and try again.`;
    }'''

def main():
    if not os.path.exists(SRC):
        sys.exit("FAIL: %s missing." % SRC)

    with io.open(SRC, encoding="utf-8", newline="") as fh:
        code = fh.read()

    if MARKER in code:
        print("already patched (doubao DOM-capture dispatch) - nothing to do")
        return

    if OLD not in code:
        sys.exit("FAIL: network-bridge guard anchor not found")
    if code.count(OLD) != 1:
        sys.exit("FAIL: anchor not unique (%d occurrences)" % code.count(OLD))

    code = code.replace(OLD, NEW, 1)

    with io.open(SRC, "w", encoding="utf-8", newline="") as fh:
        fh.write(code)

    nodepath.syntax_check(SRC, label="llmforzotero.js")

    print("  + dispatch guard: DOM-capture targets skip the network-bridge check")
    print("  + node --check passed")
    print("patched OK")

if __name__ == "__main__":
    main()
