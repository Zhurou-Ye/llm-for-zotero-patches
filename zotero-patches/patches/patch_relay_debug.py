# -*- coding: utf-8 -*-
"""
Stage-8 patch: make /debug expose the raw extension status (and DOM probe).

Why:
  The relay keeps a *normalised* copy of whatever the browser extension
  reports, but /debug only printed the pipeline status and the delivery
  contract list. Every "why did doubao fail this time?" question therefore
  had to be answered by guessing, because the interesting fields
  (composerFound, sendControlState, url, siteId, lastDiagnostic and the
  content script's domProbe fingerprint) were stored but never surfaced.

What this patch does:
  - ExtensionStatusEndpoint keeps `domProbe` (and `sendControlState`) as
    reported by the extension.
  - /debug additionally returns the whole stored extension status, so a
    single `curl` shows what the bridge actually sees.
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

MARKER = "RELAY DEBUG EXTENSION STATUS PATCH"

OLD_STATUS = '''          lastDiagnostic: normalizeTurnDiagnostic(
            {
              ...body.lastDiagnostic && typeof body.lastDiagnostic === "object" ? body.lastDiagnostic : {},
              siteId: body.siteId
            },
            null
          ) || null,
          ts: Date.now()
        };'''

NEW_STATUS = '''          lastDiagnostic: normalizeTurnDiagnostic(
            {
              ...body.lastDiagnostic && typeof body.lastDiagnostic === "object" ? body.lastDiagnostic : {},
              siteId: body.siteId
            },
            null
          ) || null,
          // RELAY DEBUG EXTENSION STATUS PATCH: keep the content script's DOM
          // fingerprint so /debug can show what the tab actually looks like.
          domProbe: body.domProbe && typeof body.domProbe === "object" ? body.domProbe : null,
          ts: Date.now()
        };'''

OLD_DEBUG = '''      DebugEndpoint = createEndpoint(["GET"], () => {
        return jsonReply({
          status: S3().status,
          extension_supported_delivery_contracts: relayGetExtensionStatus()?.supportedDeliveryContracts || []
        });
      });'''

NEW_DEBUG = '''      DebugEndpoint = createEndpoint(["GET"], () => {
        // RELAY DEBUG EXTENSION STATUS PATCH: surface the full stored status.
        const ext = relayGetExtensionStatus() || null;
        return jsonReply({
          status: S3().status,
          extension_supported_delivery_contracts: ext?.supportedDeliveryContracts || [],
          extension_status: ext,
          extension_status_age_ms: ext?.ts ? Date.now() - ext.ts : null
        });
      });'''

def main():
    if not os.path.exists(SRC):
        sys.exit("FAIL: %s missing." % SRC)

    with io.open(SRC, encoding="utf-8", newline="") as fh:
        code = fh.read()

    if MARKER in code:
        print("already patched (relay debug extension status) - nothing to do")
        return

    for anchor in (OLD_STATUS, OLD_DEBUG):
        if anchor not in code:
            sys.exit("FAIL: anchor not found:\n%s" % anchor[:120])
        if code.count(anchor) != 1:
            sys.exit("FAIL: anchor not unique (%d)" % code.count(anchor))

    code = code.replace(OLD_STATUS, NEW_STATUS, 1)
    code = code.replace(OLD_DEBUG, NEW_DEBUG, 1)

    with io.open(SRC, "w", encoding="utf-8", newline="") as fh:
        fh.write(code)

    nodepath.syntax_check(SRC, label="llmforzotero.js")

    print("  + /debug: full extension status + domProbe passthrough")
    print("  + node --check passed")
    print("patched OK")

if __name__ == "__main__":
    main()
