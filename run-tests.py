#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Run every offline test suite and print one summary.

    python run-tests.py            # all suites
    python run-tests.py -v         # also print each suite's own output

Offline means: no Zotero, no browser, no network. That matters because these
are the suites that have to pass before anything is published.

Excluded on purpose:
  - browser-extension/tests/probe_doubao_media.js      reads a live Doubao tab
  - .../legacy/e2e_search_test.js                      performs real searches

A Node-based runner was tried first and does not work: spawning `node` as a
child process fails with EBUSY on Windows for the binary that is currently
executing, and running the suites in-process instead pollutes their shared
globals (they all use `vm` contexts). Driving them from Python keeps each suite
in its own process, which is what they were written for.

The linkedom-based suites are skipped with a clear message when the dependency
is missing, because "you have not run npm install" is a setup gap, not a
regression.
"""
from __future__ import print_function

import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

SUITES = [
    ("zotero-patches/tests/test_search_loop.js", None),
    ("zotero-patches/tests/test_segment_stall.js", None),
    ("browser-extension/tests/verify_doubao_focus_and_completion.js", None),
    ("browser-extension/tests/verify_doubao_userturn_binding.js", None),
    ("browser-extension/tests/verify_doubao_media.js", None),
    ("browser-extension/tests/legacy/test_doubao_adapter.js", "linkedom"),
    ("browser-extension/tests/legacy/test_gemini_upload.js", "linkedom"),
]

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    GREEN = RED = YELLOW = DIM = RESET = ""


def find_node():
    """The Node that runs the tests. Patches also shell out to `node --check`."""
    for env in ("SYNC_ZOTERO_NODE", "NODE"):
        candidate = os.environ.get(env)
        if candidate and os.path.exists(candidate):
            return candidate
    from shutil import which
    found = which("node")
    if found:
        return found
    sys.exit("node not found on PATH.\n"
             "Install Node.js 18+, or set SYNC_ZOTERO_NODE=/path/to/node.")


def has_linkedom():
    probe = (
        "try { require.resolve('linkedom'); process.exit(0); } "
        "catch (e) { process.exit(1); }"
    )
    return subprocess.call([NODE, "-e", probe], cwd=HERE) == 0


def tally(output):
    passes = len(re.findall(r"^\s*PASS\s", output, re.M))
    total = len(re.findall(r"^\s*(?:PASS|FAIL)\s", output, re.M))
    return passes, total


def main():
    global NODE
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    NODE = find_node()
    linkedom = has_linkedom()

    passed = failed = skipped = 0
    assertions = 0
    failures = []

    for relative, needs in SUITES:
        label = relative.replace("\\", "/")
        if needs == "linkedom" and not linkedom:
            print("%sSKIP%s  %s  %s(needs linkedom: npm install)%s"
                  % (YELLOW, RESET, label, DIM, RESET))
            skipped += 1
            continue

        target = os.path.join(HERE, *relative.split("/"))
        if not os.path.exists(target):
            print("%sFAIL%s  %s  %s(file not found)%s" % (RED, RESET, label, DIM, RESET))
            failures.append((label, ""))
            failed += 1
            continue

        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.Popen([NODE, target], cwd=HERE, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out = proc.communicate()[0].decode("utf-8", "replace")
        ok = proc.returncode == 0

        suite_passes, suite_total = tally(out)
        assertions += suite_total
        if verbose or not ok:
            print(out.rstrip())
            print("")

        if ok:
            note = ("  (%d/%d)" % (suite_passes, suite_total)) if suite_total else ""
            print("%sPASS%s  %s%s" % (GREEN, RESET, label, note))
            passed += 1
        else:
            print("%sFAIL%s  %s  (%d/%d)" % (RED, RESET, label, suite_passes, suite_total))
            failures.append((label, out))
            failed += 1

    if failures:
        print("")
        print("=" * 68)
        print("  failure detail")
        print("=" * 68)
        for label, out in failures:
            print("")
            print("--- %s ---" % label)
            if not out:
                print("  (no output)")
                continue
            lines = out.rstrip().splitlines()
            print("\n".join(lines[-40:]))

    print("")
    print("=" * 68)
    print("  %d suite(s) passed, %d failed, %d skipped%s"
          % (passed, failed, skipped,
             (", %d assertions" % assertions) if assertions else ""))
    if skipped:
        print("  %d skipped for missing linkedom -- run `npm install` to include them" % skipped)
    print("=" * 68)

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
