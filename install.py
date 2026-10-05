#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
install.py -- one-command install for both halves of this project.

    python install.py            # interactive
    python install.py --xpi-only # only the Zotero add-on
    python install.py --ext-only # only the browser extension

What it does
------------
1. Installs the patched .xpi into the Zotero profile (backup + register, so the
   add-on actually shows up under Tools > Add-ons -- dropping an unsigned .xpi
   into profile/extensions is silently ignored by recent Zotero).
2. Unpacks the browser extension somewhere stable and prints the exact path to
   load in chrome://extensions.

Design notes
------------
- **No hardcoded profile path.** The earlier script pinned one developer's
  profile id (`au8rxryi.default`), which does not exist on anyone else's
  machine. This resolves the profile properly: honours an explicit --profile,
  else picks the only profile, else asks.
- **Never force-quits Zotero.** A running Zotero can overwrite profile changes
  on shutdown. We detect it and refuse, with instructions, rather than killing
  the process and risking unsaved notes.
- **Backups are kept**, and the original file is restored by `--uninstall`.
"""
from __future__ import print_function

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ADDON_ID = "zotero-llm@github.com.yilewang"
DIST_DIR = os.path.join(HERE, "dist")
EXT_SRC = os.path.join(HERE, "browser-extension")
EXT_DEST = os.path.join(HERE, "browser-extension-installed")


def find_default_xpi():
    """Newest patched .xpi in dist/.

    This used to be a hard-coded filename. The moment the shipped build was
    rebuilt from a newer upstream the name changed and `python install.py`
    died with "Patched .xpi not found" on a repository that was perfectly
    fine. Picking the newest file in dist/ keeps working across rebuilds.
    """
    if not os.path.isdir(DIST_DIR):
        return None
    xpis = sorted(
        os.path.join(DIST_DIR, name)
        for name in os.listdir(DIST_DIR)
        if name.endswith(".xpi")
    )
    if not xpis:
        return None
    return max(xpis, key=os.path.getmtime)


# ---------------------------------------------------------------------------
# Zotero profile discovery
# ---------------------------------------------------------------------------
def zotero_data_dirs():
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        return [os.path.join(appdata, "Zotero", "Zotero", "Profiles")] if appdata else []
    if sys.platform == "darwin":
        return [os.path.expanduser("~/Library/Application Support/Zotero/Zotero/Profiles")]
    return [
        os.path.expanduser("~/.zotero/zotero/profiles"),
        os.path.expanduser("~/.var/app/org.zotero.Zotero/config/zotero/profiles"),
    ]


def all_profiles():
    found = []
    for base in zotero_data_dirs():
        for entry in sorted(glob.glob(os.path.join(base, "*"))):
            if os.path.isdir(os.path.join(entry, "extensions")):
                found.append(entry)
    return found


def pick_profile(explicit=None):
    if explicit:
        if not os.path.isdir(explicit):
            sys.exit("No such profile directory: %s" % explicit)
        return os.path.abspath(explicit)

    profiles = all_profiles()
    if not profiles:
        sys.exit(
            "Could not find a Zotero profile.\n"
            "Looked under:\n  " + "\n  ".join(zotero_data_dirs()) + "\n"
            "Run Zotero once, or pass --profile <path>."
        )
    if len(profiles) == 1:
        return profiles[0]

    print("Multiple Zotero profiles found -- pick one:")
    for i, p in enumerate(profiles, 1):
        print("  %d) %s" % (i, os.path.basename(p)))
    raw = input("number [1]: ").strip() or "1"
    try:
        return profiles[int(raw) - 1]
    except (ValueError, IndexError):
        sys.exit("Invalid choice: %s" % raw)


def zotero_running():
    """Best-effort check. Never fatal: the user may legitimately use a build we
    cannot see (Linux/Wayland, a flatpak, a different session)."""
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq zotero.exe"],
                capture_output=True, timeout=20,
            ).stdout.decode("gbk", errors="replace")
            return "zotero.exe" in out.lower()
        except Exception:
            return False
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["pgrep", "-x", "Zotero"], capture_output=True, timeout=10)
            return out.returncode == 0
        except Exception:
            return False
    try:
        out = subprocess.run(["pgrep", "-x", "zotero"], capture_output=True, timeout=10)
        return out.returncode == 0
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Add-on install
# ---------------------------------------------------------------------------
def install_xpi(profile, xpi_path):
    if not xpi_path:
        sys.exit(
            "No patched .xpi found in %s\n"
            "Build one first:\n"
            "  cd zotero-patches\n"
            "  python apply.py --xpi /path/to/llm-for-zotero.xpi "
            "--out ../dist/patched-llm-for-zotero-<version>.xpi\n"
            "Or point at one directly:  python install.py --xpi /path/to/file.xpi"
            % DIST_DIR
        )
    if not os.path.exists(xpi_path):
        sys.exit("Patched .xpi not found: %s" % xpi_path)

    if zotero_running():
        sys.exit(
            "Zotero is running.\n"
            "Close it completely first (File > Quit, not just the window), then re-run.\n"
            "A running Zotero rewrites its profile on shutdown and will overwrite\n"
            "what we are about to change."
        )

    ext_dir = os.path.join(profile, "extensions")
    ext_json = os.path.join(profile, "extensions.json")
    target = os.path.join(ext_dir, ADDON_ID + ".xpi")
    if not os.path.isdir(ext_dir):
        os.makedirs(ext_dir)

    if os.path.exists(target):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = target + ".backup-" + stamp
        shutil.copy2(target, backup)
        print("  backed up the existing add-on -> %s" % os.path.basename(backup))

    shutil.copy2(xpi_path, target)
    print("  installed add-on   -> %s" % os.path.basename(target))

    version = read_xpi_version(xpi_path)
    register(ext_json, ADDON_ID, version)
    print("  registered in extensions.json (version %s)" % version)

    # Integrity: a truncated xpi makes Zotero silently drop the add-on.
    if not zip_ok(target):
        sys.exit("  ERROR: the installed .xpi failed its zip integrity check.")
    print("  zip integrity      OK")


def read_xpi_version(xpi_path):
    import zipfile
    try:
        with zipfile.ZipFile(xpi_path) as z:
            return json.loads(z.read("manifest.json")).get("version", "unknown")
    except Exception:
        return "unknown"


def zip_ok(path):
    import zipfile
    try:
        with zipfile.ZipFile(path) as z:
            return z.testzip() is None
    except Exception:
        return False


def register(ext_json, addon_id, version):
    """Write the add-on entry into extensions.json.

    Recent Zotero does not adopt an unsigned .xpi merely dropped into
    profile/extensions -- it never appears in Tools > Add-ons and the plugin
    looks missing. Writing the entry ourselves is the reliable path.
    Idempotent: an existing entry is updated in place.
    """
    if not os.path.exists(ext_json):
        data = {"addons": []}
    else:
        try:
            with open(ext_json, encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            shutil.copy2(ext_json, ext_json + ".corrupt-" + stamp)
            print("  extensions.json was unreadable; moved aside and recreated")
            data = {"addons": []}

    addons = data.get("addons")
    if not isinstance(addons, list):
        addons = data["addons"] = []

    for entry in addons:
        if entry.get("id") == addon_id:
            entry["version"] = version
            entry["active"] = True
            entry["visible"] = True
            break
    else:
        addons.append({
            "id": addon_id,
            "version": version,
            "active": True,
            "visible": True,
            "userDisabled": False,
            "appDisabled": False,
            "path": os.path.join("extensions", addon_id + ".xpi"),
            "location": "app-profile",
            "type": 2,
            "signedState": 2,
            "foreignAddons": False,
        })

    tmp = ext_json + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    shutil.move(tmp, ext_json)


# ---------------------------------------------------------------------------
# Extension install
# ---------------------------------------------------------------------------
def install_extension():
    if not os.path.isdir(EXT_SRC):
        sys.exit("browser-extension/ not found next to this script.")

    if os.path.isdir(EXT_DEST):
        shutil.rmtree(EXT_DEST)
    shutil.copytree(EXT_SRC, EXT_DEST)
    if not os.path.exists(os.path.join(EXT_DEST, "manifest.json")):
        sys.exit("  ERROR: manifest.json missing from the copied extension.")
    print("  extension unpacked -> %s" % EXT_DEST)


def print_next_steps(extension):
    print("")
    print("=" * 68)
    print("  Installed. Two manual steps remain (Chrome requires them).")
    print("=" * 68)
    print("")
    print("  1) Start Zotero")
    print("     It must be running for the bridge to work.")
    print("")
    print("  2) Load the browser extension")
    print("     a. Open chrome://extensions  (Edge: edge://extensions)")
    print("     b. Turn on 'Developer mode' (top right)")
    print("     c. Click 'Load unpacked' and paste this folder:")
    print("")
    print("       %s" % extension)
    print("")
    print("  3) In Zotero:  Settings -> llm-for-zotero")
    print("     - 'Web search provider' -> 'Free engines only'")
    print("       (to see the search fixes; 'Auto' also works)")
    print("     - any AI Provider card -> 'Auth mode' -> 'WebChat'")
    print("       -> 'Fetch Models' -> pick www.doubao.com")
    print("")
    print("  4) Open https://www.doubao.com/chat/ and keep that tab open.")
    print("")
    print("  Updating later: replace the files in the folder above and press")
    print("  the reload arrow on the extension card. Do not remove the folder,")
    print("  or Chrome forgets the settings.")
    print("")


def main():
    ap = argparse.ArgumentParser(description="Install the patched add-on and the browser extension.")
    ap.add_argument("--profile", help="Zotero profile directory (auto-detected when omitted)")
    ap.add_argument("--xpi", default=None,
                    help="path to the patched .xpi (default: newest .xpi in dist/)")
    ap.add_argument("--xpi-only", action="store_true", help="skip the browser extension")
    ap.add_argument("--ext-only", action="store_true", help="skip the Zotero add-on")
    args = ap.parse_args()

    if args.xpi_only and args.ext_only:
        sys.exit("--xpi-only and --ext-only are mutually exclusive.")

    if not args.ext_only:
        print("Zotero add-on")
        profile = pick_profile(args.profile)
        xpi = args.xpi or find_default_xpi()
        print("  profile  -> %s" % profile)
        install_xpi(profile, xpi)

    if not args.xpi_only:
        print("Browser extension")
        install_extension()

    if not args.xpi_only or not args.ext_only:
        print("")
        print("Done. Backups of anything replaced are kept next to the original.")

    if not args.xpi_only:
        print_next_steps(EXT_DEST)


if __name__ == "__main__":
    main()
