#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply.py -- one-shot entry point.

Takes the ORIGINAL llm-for-zotero .xpi that you already have installed,
extracts it to a scratch directory, applies every patch, and repackages an
installable .xpi.

    python apply.py --xpi "/path/to/zotero-llm@github.com.yilewang.xpi"

Nothing from upstream is stored in this repository. Each patch operates on a
local copy that you obtained yourself, and is idempotent (safe to re-run).

Options
-------
  --xpi PATH     source add-on archive (required unless --src is given)
  --src DIR      reuse an already-extracted add-on directory
  --out PATH     output .xpi (default: ./patched-llm-for-zotero.xpi)
  --work DIR     scratch directory (default: ./.build next to this script)
  --keep         keep the scratch directory after building
  --skip-tolerant
                 do not abort if an optional patch cannot be applied
"""
from __future__ import print_function

import argparse
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PATCHES = os.path.join(HERE, "patches")

# Core patches: failure here means the build is NOT usable.
REQUIRED = [
    ("patch_webaccess.py", "key-less multi-engine web search provider"),
    ("patch_search_quality.py", "query cleanup, quality ranking, body enrichment, loop brake"),
    ("patch_search_loop.py", "per-run search ledger, repeat detection, hard search budget"),
    ("patch_agent_segment.py", "segment stall guard: wrap up instead of killing the run"),
    ("patch_doubao_target.py", "register www.doubao.com as a WebChat target"),
    ("patch_doubao_ui.py", "Doubao provider icon + preset styling"),
    ("patch_doubao_dispatch.py", "let DOM-capture targets (doubao) reach dispatch"),
    ("patch_doubao_composer.py", "DOM-capture targets treat composerFound as advisory"),
    ("patch_relay_debug.py", "/debug exposes the raw extension status + DOM probe"),
    ("patch_target_switch.py", "publish the requested target before pre-flight validation"),
]

OPTIONAL = []


def run_patch(script, work, label):
    path = os.path.join(PATCHES, script)
    if not os.path.exists(path):
        print("  MISS  %s (script not found)" % script)
        return False
    env = dict(os.environ)
    env["ZOTERO_WORKDIR"] = work
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [sys.executable, path], env=env, cwd=work,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = (proc.stdout or b"").decode("utf-8", "replace").strip()
    ok = proc.returncode == 0
    print("  %s  %-28s %s" % ("OK  " if ok else "FAIL", script, label))
    if not ok and out:
        for line in out.splitlines()[-6:]:
            print("         | " + line)
    return ok


def extract(xpi, dest):
    if not os.path.exists(xpi):
        sys.exit("xpi not found: %s" % xpi)
    with zipfile.ZipFile(xpi) as z:
        if z.testzip() is not None:
            sys.exit("xpi appears corrupted")
        names = z.namelist()
        if "manifest.json" not in names:
            sys.exit("not a Zotero add-on: manifest.json missing")
        # Some builds wrap everything in an extra directory; flatten it.
        roots = {n.split("/")[0] for n in names if "/" in n}
        prefix = ""
        if len(roots) == 1:
            only = roots.pop()
            if os.path.join(only, "manifest.json") in names:
                prefix = only + "/"
        target = os.path.join(dest, "zotero-llm-src", "xpi")
        os.makedirs(target, exist_ok=True)
        for n in names:
            rel = n[len(prefix):] if n.startswith(prefix) else n
            if not rel:
                continue
            z.extract(n, target)
            if prefix:
                src = os.path.join(target, n.replace("/", os.sep))
                dst = os.path.join(target, rel.replace("/", os.sep))
                if src != dst and os.path.exists(src):
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    if os.path.isfile(src):
                        shutil.move(src, dst)
        if prefix:
            leftover = os.path.join(target, prefix.rstrip("/"))
            shutil.rmtree(leftover, ignore_errors=True)
    return target


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--xpi")
    ap.add_argument("--src")
    ap.add_argument("--out", default=os.path.join(HERE, "patched-llm-for-zotero.xpi"))
    ap.add_argument("--work", default=os.path.join(HERE, ".build"))
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--skip-tolerant", action="store_true")
    args = ap.parse_args()

    if not args.xpi and not args.src:
        ap.error("one of --xpi or --src is required")

    work = os.path.abspath(args.work)
    if args.src:
        src = os.path.abspath(args.src)
        dest = os.path.join(work, "zotero-llm-src", "xpi")
        if os.path.abspath(src) != os.path.abspath(dest):
            shutil.rmtree(dest, ignore_errors=True)
            shutil.copytree(src, dest)
        print("using existing source directory: %s" % src)
    else:
        shutil.rmtree(work, ignore_errors=True)
        target = extract(args.xpi, work)
        print("extracted to: %s" % target)

    print("\napplying patches")
    failures = []
    for script, label in REQUIRED:
        if not run_patch(script, work, label):
            failures.append(script)
    for script, label in OPTIONAL:
        run_patch(script, work, label)

    if failures and not args.skip_tolerant:
        sys.exit("\naborted: %s did not apply cleanly.\n"
                 "Most likely the upstream bundle changed shape. Open an issue "
                 "with the add-on version and the failure lines above."
                 % ", ".join(failures))

    print("\nbuilding xpi")
    build = os.path.abspath(os.path.join(PATCHES, "build_xpi.py"))
    env = dict(os.environ)
    env["ZOTERO_WORKDIR"] = work
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [sys.executable, build, "--root=%s" % work, "--out=%s" % os.path.abspath(args.out)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = (proc.stdout or b"").decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        print(out)
        sys.exit("build failed")
    print(out)

    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
        print("scratch directory removed")

    print("\ndone -> %s" % os.path.abspath(args.out))
    print("Install with Zotero closed, then: Settings -> llm-for-zotero")


if __name__ == "__main__":
    main()
