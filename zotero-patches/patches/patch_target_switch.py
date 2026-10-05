# -*- coding: utf-8 -*-
"""
Stage-9 patch: publish the requested target *before* validating it.

Deadlock this removes:
  The browser extension learns which site to track from the relay heartbeat
  (``active_target``). The relay only published ``active_target`` *after* a
  submit passed validation -- and validation compares the requested target
  against the extension's cached status, which still describes the previously
  tracked site. So switching provider (or simply restarting Zotero) produced

      "The active extension tab is not Doubao. Open www.doubao.com and try again."

  forever: the submit was rejected before the extension was ever told to look
  at doubao, so the cached status never changed.

What this patch does:
  As soon as a submit names a known WebChat target, publish it as the active
  target. The extension switches on its next heartbeat (~5 s) and the retry
  succeeds.
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

MARKER = "RELAY TARGET SWITCH PATCH"

OLD = '''        const requestedTarget = typeof body.target === "string" ? body.target : S3().active_target || null;
        const compatibilityError = validateDeliveryContractForDispatch(
          requestedDeliveryContractVersion,
          requestedTarget
        );'''

NEW = '''        const requestedTarget = typeof body.target === "string" ? body.target : S3().active_target || null;
        // RELAY TARGET SWITCH PATCH: publish the requested target before the
        // pre-flight runs. The extension follows `active_target` from the
        // heartbeat; validating first meant a just-switched (or freshly
        // restarted) target was rejected against the previous site's cached
        // status and the switch never happened.
        if (requestedTarget && getWebChatTarget(requestedTarget)) {
          S3().active_target = requestedTarget;
        }
        const compatibilityError = validateDeliveryContractForDispatch(
          requestedDeliveryContractVersion,
          requestedTarget
        );'''

def main():
    if not os.path.exists(SRC):
        sys.exit("FAIL: %s missing." % SRC)

    with io.open(SRC, encoding="utf-8", newline="") as fh:
        code = fh.read()

    if MARKER in code:
        print("already patched (relay target switch) - nothing to do")
        return

    if OLD not in code:
        sys.exit("FAIL: submit_query anchor not found")
    if code.count(OLD) != 1:
        sys.exit("FAIL: anchor not unique (%d occurrences)" % code.count(OLD))

    code = code.replace(OLD, NEW, 1)

    with io.open(SRC, "w", encoding="utf-8", newline="") as fh:
        fh.write(code)

    nodepath.syntax_check(SRC, label="llmforzotero.js")

    print("  + submit_query: publish target before pre-flight validation")
    print("  + node --check passed")
    print("patched OK")

if __name__ == "__main__":
    main()
