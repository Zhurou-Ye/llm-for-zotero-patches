# -*- coding: utf-8 -*-
"""
nodepath.py -- locate a Node.js executable, portably.

Why this exists
---------------
Every patch script rewrites `llmforzotero.js` and then runs `node --check` on
the result, so that a bad anchor is reported as a syntax error instead of
silently shipping a broken plugin. That check needs a Node binary.

The scripts this replaced hardcoded one developer's absolute path to their own
managed Node install. On any other machine that path does not exist, so
`subprocess.run([NODE, ...])` raised FileNotFoundError and **every** patch
failed -- including for users who had Node installed perfectly well. The
resolved path is a hard requirement, not a convenience.

Resolution order
----------------
1. `SYNC_ZOTERO_NODE` -- explicit override, always wins.
2. `node` / `node.exe` on PATH (via shutil.which).
3. Well-known install locations, per platform.
4. Common version-manager locations (nvm, fnm, volta, asdf).

If nothing is found we do NOT hard-fail. The syntax check is a safety net; not
having Node means we cannot run it, which is a different situation from the
Node being present and reporting a syntax error. Patches are string-level and
idempotent, and `apply.py` verifies the final bundle separately, so skipping
the check with a visible warning is safer than aborting a build that is
actually fine.
"""
from __future__ import print_function

import os
import shutil
import subprocess

IS_WIN = os.name == "nt"

# Candidate interpreters tried when Node is not on PATH.
_WELL_KNOWN = [
    r"C:\Program Files\nodejs\node.exe",
    r"C:\Program Files (x86)\nodejs\node.exe",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/opt/homebrew/bin/node",
    "/opt/local/bin/node",
    "/snap/bin/node",
]

# Version managers keep node under a versioned directory, so glob for it.
_GLOBS = [
    os.path.expanduser("~/.nvm/versions/node/*/bin/node"),
    os.path.expanduser("~/AppData/Roaming/nvm/*/node.exe"),
    os.path.expanduser("~/.fnm/node-versions/*/installation/bin/node"),
    os.path.expanduser("~/.volta/bin/node"),
    os.path.expanduser("~/.asdf/shims/node"),
]


def _from_glob():
    import glob
    # Newest version last-wins is good enough; we only need *a* working node.
    for pattern in _GLOBS:
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[-1]
    return None


def resolve_node(required=False):
    """
    Return a path to a Node executable, or None when none can be found.

    With required=True a missing Node is fatal; otherwise it returns None so
    the caller can downgrade the syntax check to a warning.
    """
    override = os.environ.get("SYNC_ZOTERO_NODE")
    if override:
        if os.path.exists(override):
            return override
        if required:
            raise SystemExit(
                "SYNC_ZOTERO_NODE is set to %r but that file does not exist.\n"
                "Point it at a Node.js executable, or unset it to auto-detect."
                % override
            )

    found = shutil.which("node") or shutil.which("node.exe")
    if found:
        return found

    for candidate in _WELL_KNOWN:
        if os.path.exists(candidate):
            return candidate

    from_glob = _from_glob()
    if from_glob:
        return from_glob

    if required:
        raise SystemExit(
            "Node.js was not found on this machine.\n"
            "The patch scripts use `node --check` to verify their own output.\n"
            "Install Node.js (https://nodejs.org) or set SYNC_ZOTERO_NODE to\n"
            "the full path of a node executable, then re-run."
        )
    return None


def syntax_check(target, label=None):
    """
    Run `node --check` on `target`.

    Returns True when the file parses, or when no Node is available (in which
    case a one-time warning has already been printed). Raises SystemExit when
    Node IS available and reports a genuine syntax error -- that is a real
    failure and must not be papered over.
    """
    node = resolve_node()
    if not node:
        if not _WARNED_NO_NODE:
            print(
                "  [warn] Node.js not found -- skipping the post-patch syntax "
                "check for %s. The patch itself is string-level and the final "
                "bundle is still verified, but install Node.js to get this "
                "check back." % (label or target)
            )
        _WARNED_NO_NODE.append(True)
        return True

    result = subprocess.run(
        [node, "--check", target],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise SystemExit(
            "FAIL: syntax error after patching %s:\n%s"
            % (target, result.stderr or result.stdout)
        )
    return True


_WARNED_NO_NODE = []
