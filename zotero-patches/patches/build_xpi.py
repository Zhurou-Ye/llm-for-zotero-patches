# -*- coding: utf-8 -*-
"""
Repackage the patched extension into an installable .xpi.

Changes vs original manifest:
  - version bumped to <upstream>.9 so it is never silently downgraded, and so
    a build made from a newer upstream does not masquerade as an older one
  - update_url removed so upstream releases cannot overwrite this patch

The bump is derived from whatever upstream version was fed in, not hard-coded.
Pinning it to 3.9.9.9 meant a build made from upstream 3.9.10 shipped with a
*lower* version number than the add-on the user already had, which Zotero
treats as a downgrade -- exactly the case the bump exists to prevent.

Usage:
    python build_xpi.py [--root=DIR] [--out=FILE]

--root defaults to $ZOTERO_WORKDIR, then to the current working directory.
"""
import io, json, os, re, sys, zipfile

ROOT = None
OUT_ARG = None
for arg in sys.argv[1:]:
    if arg.startswith("--root="):
        ROOT = arg.split("=", 1)[1]
    elif arg.startswith("--out="):
        OUT_ARG = arg.split("=", 1)[1]
ROOT = ROOT or os.environ.get("ZOTERO_WORKDIR") or os.getcwd()

SRC_DIR = os.path.join(ROOT, "zotero-llm-src", "xpi")
OUT = OUT_ARG or os.path.join(ROOT, "zotero-llm-free-web.xpi")


def patched_version(upstream):
    """<upstream>.9 -- a fourth segment Zotero always reads as "newer".

    Keeps whatever the upstream version was (3.9.9.9 stays 3.9.9.9, 3.9.10
    becomes 3.9.10.9) so the add-on's own version line never goes backwards.
    """
    return "%s.9" % upstream


def main():
    manifest_path = os.path.join(SRC_DIR, "manifest.json")
    with io.open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)

    upstream_version = str(manifest.get("version") or "0.0.0")
    # An upstream that already carries a fourth segment (3.9.9.9) is left
    # alone rather than growing a fifth one Zotero may reject.
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", upstream_version):
        new_version = upstream_version
    else:
        new_version = patched_version(upstream_version)

    manifest["version"] = new_version
    apps = manifest.get("applications") or {}
    zotero = apps.get("zotero") or {}
    zotero.pop("update_url", None)
    # Zotero 7+ reads snake_case min_version/max_version. A manifest that only
    # carries the Zotero-5 era strict_min_version/strict_max_version fields is
    # treated as incompatible by Zotero 10 and the add-on is dropped silently
    # (never registered, never shown in Tools > Add-ons). Always emit both.
    minv = zotero.get("min_version") or zotero.get("strict_min_version") or "6.999"
    maxv = zotero.get("max_version") or zotero.get("strict_max_version") or "*"
    zotero["min_version"] = minv
    zotero["max_version"] = maxv
    zotero.setdefault("strict_min_version", minv)
    zotero.setdefault("strict_max_version", maxv)
    apps["zotero"] = zotero
    manifest["applications"] = apps
    manifest_json = json.dumps(manifest, indent=2, ensure_ascii=False)

    files = []
    for root, dirs, names in os.walk(SRC_DIR):
        dirs.sort()
        for name in sorted(names):
            if name.endswith(".orig.bak") or name.endswith(".bak"):
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, SRC_DIR).replace("\\", "/")
            files.append((rel, full))

    files.sort(key=lambda item: item[0] != "manifest.json")

    if os.path.exists(OUT):
        os.remove(OUT)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", manifest_json)
        for rel, full in files:
            if rel == "manifest.json":
                continue
            zf.write(full, rel)

    print("built:", OUT)
    print("  files:", len(files))
    print("  size :", os.path.getsize(OUT), "bytes")
    print("  version:", upstream_version, "->", new_version,
          "| update_url removed:", "update_url" not in manifest_json)

    # sanity: every entry readable, manifest parses, bundle present
    with zipfile.ZipFile(OUT) as zf:
        bad = zf.testzip()
        names = set(zf.namelist())
    print("  zip integrity:", "OK" if bad is None else "CORRUPT -> " + str(bad))
    assert "manifest.json" in names, "manifest missing"
    assert "content/scripts/llmforzotero.js" in names, "bundle missing"
    with zipfile.ZipFile(OUT) as zf:
        check = json.loads(zf.read("manifest.json").decode("utf-8"))
        bundle = zf.read("content/scripts/llmforzotero.js").decode("utf-8")
    assert check["version"] == new_version
    assert "FreeWebAccessProvider" in bundle, "patch missing from bundle"
    print("  verified: patched bundle + new manifest inside package")


if __name__ == "__main__":
    main()
