# -*- coding: utf-8 -*-
"""
Stage-3 patch: teach llm-for-zotero's webchat mode about doubao.com.

Stage 1 (patch_webaccess.py) and stage 2 (patch_search_quality.py) must have run
first, because this script patches the already-patched bundle and the chain is
designed to replay linearly.

Why this node:
  WEBCHAT_TARGETS (src/webchat/types.ts) is a plain array. getWebChatTargetByUrl()
  matches with `parsed.host === target.hostname` -- an EXACT host comparison, so
  the hostname must be "www.doubao.com", not "doubao.com".
  getDefaultWebChatTarget() returns WEBCHAT_TARGETS[0], so appending at the end
  keeps ChatGPT as the default and nothing else shifts.
  answerCapture "dom" is required: doubao is client-rendered and, unlike ChatGPT/
  DeepSeek, we do not have a verified network capture contract, so we read the
  rendered DOM exactly the way the Gemini adapter does.

Note: the protocol helperText is built from WEBCHAT_TARGETS.map(...).join(", "),
so it picks up doubao automatically once the entry exists.
"""
import io
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nodepath  # noqa: E402  (portable `node --check` lookup)
# apply.py exports ZOTERO_WORKDIR and runs the patches there; running by hand
# from a checkout works the same way. Try the scratch dir first.
_WORKDIR = os.environ.get("ZOTERO_WORKDIR") or HERE
SRC = os.path.join(_WORKDIR, "zotero-llm-src", "xpi", "content", "scripts", "llmforzotero.js")
MARKER = 'id: "doubao"'

# The Gemini tail: its "dom" answerCapture is unique, which makes this anchor safe.
OLD_TARGETS_TAIL = '''        {
          id: "gemini",
          label: "Google Gemini",
          defaultHost: "http://127.0.0.1:23119/llm-for-zotero/webchat",
          modelName: "gemini.google.com",
          hostname: "gemini.google.com",
          displayName: "gemini",
          conversationPathPattern: /^\\/app\\/([a-f0-9]{16})\\/?$/,
          answerCapture: "dom"
        }
      ];'''

NEW_TARGETS_TAIL = '''        {
          id: "gemini",
          label: "Google Gemini",
          defaultHost: "http://127.0.0.1:23119/llm-for-zotero/webchat",
          modelName: "gemini.google.com",
          hostname: "gemini.google.com",
          displayName: "gemini",
          conversationPathPattern: /^\\/app\\/([a-f0-9]{16})\\/?$/,
          answerCapture: "dom"
        },
        {
          id: "doubao",
          label: "Doubao",
          defaultHost: "http://127.0.0.1:23119/llm-for-zotero/webchat",
          modelName: "www.doubao.com",
          hostname: "www.doubao.com",
          displayName: "doubao",
          conversationPathPattern: /^\\/chat\\/([A-Za-z0-9_.\\-]+)\\/?$/,
          answerCapture: "dom"
        }
      ];'''

def main():
    if not os.path.exists(SRC):
        sys.exit("FAIL: %s missing. Run patch_webaccess.py first." % SRC)

    with io.open(SRC, encoding="utf-8", newline="") as fh:
        code = fh.read()

    if "FREE WEB ACCESS PATCH" not in code:
        sys.exit("FAIL: stage-1 patch missing. Run patch_webaccess.py first.")

    if MARKER in code:
        print("already patched (doubao target present) - nothing to do")
        return

    if OLD_TARGETS_TAIL not in code:
        sys.exit("FAIL: WEBCHAT_TARGETS tail anchor not found")
    if code.count(OLD_TARGETS_TAIL) != 1:
        sys.exit("FAIL: anchor not unique")

    code = code.replace(OLD_TARGETS_TAIL, NEW_TARGETS_TAIL, 1)

    with io.open(SRC, "w", encoding="utf-8", newline="") as fh:
        fh.write(code)

    nodepath.syntax_check(SRC, label="llmforzotero.js")

    print("  + WEBCHAT_TARGETS: appended doubao (answerCapture=dom, host=www.doubao.com)")
    print("  + node --check passed")
    print("patched OK")

if __name__ == "__main__":
    main()
