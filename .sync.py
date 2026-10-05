"""Sync the working tree to GitHub over the REST API.

`git push` cannot be used in this sandbox: the HTTP proxy answers curl and
urllib but rejects git's own CONNECT tunnel with `502 CONNECT tunnel failed`.
So this drives the Git Data API instead.

Only files whose blob SHA differs from what is already on the remote get
uploaded, so re-running after a one-file edit costs a handful of calls, not a
few hundred. Uploads run concurrently; serial round trips through the proxy are
slow enough to hit the tool timeout.

Usage:  GH_TOKEN=... python sync_to_github.py [branch]
"""
import base64
import concurrent.futures
import json
import os
import sys
import time
import urllib.error
import urllib.request

REPO = "Zhurou-Ye/llm-for-zotero-patches"
BRANCH = sys.argv[1] if len(sys.argv) > 1 else "main"
API = "https://api.github.com"
ROOT = r"D:\WorkBuddyData\2026-10-01-10-20-58\publish"
TOKEN = os.environ["GH_TOKEN"]

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".idea", ".vscode"}
SKIP_SUFFIX = (".pyc", ".orig", ".bak", ".log")
WORKERS = 8
_calls = 0


def call(method, path, body=None, retries=3):
    global _calls
    _calls += 1
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Authorization": "Bearer " + TOKEN,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    last = ""
    for attempt in range(retries):
        req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            if exc.code < 500 and exc.code != 429:
                raise SystemExit("API %s %s -> %s\n%s" % (method, path, exc.code, detail[:400]))
            last = "%s %s" % (exc.code, detail[:200])
        except Exception as exc:
            last = repr(exc)
        time.sleep(1.5 * (attempt + 1))
    raise SystemExit("giving up on %s %s -> %s" % (method, path, last))


def collect():
    out = []
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in sorted(files):
            if name.endswith(SKIP_SUFFIX) or name == ".DS_Store":
                continue
            abspath = os.path.join(base, name)
            out.append((os.path.relpath(abspath, ROOT).replace(os.sep, "/"), abspath))
    return sorted(out)


def git_blob_sha(path):
    """Git's own object id for a file, so we can skip unchanged uploads.

    GitHub's trees API reports blob SHAs, so computing the same id locally is
    what makes an incremental sync possible. `git hash-object` would need the
    git binary, which cannot run here, so this is the same algorithm inline.
    """
    import hashlib
    data = open(path, "rb").read()
    header = ("blob %d\0" % len(data)).encode("ascii")
    return hashlib.sha1(header + data).hexdigest()


def main():
    files = collect()
    remote = {}
    head = call("GET", "/repos/%s/git/ref/heads/%s" % (REPO, BRANCH))
    # The Git Data API returns a flat commit (its `tree` sits at the top level);
    # the REST /commits/ endpoint nests the same data under `commit`. Mixing the
    # two up is easy and only shows up as a KeyError here.
    base_commit = call("GET", "/repos/%s/git/commits/%s" % (REPO, head["object"]["sha"]))
    base_tree_sha = base_commit["tree"]["sha"]
    tree = call("GET", "/repos/%s/git/trees/%s?recursive=1" % (REPO, base_tree_sha))
    for entry in tree.get("tree", []):
        if entry["type"] == "blob":
            remote[entry["path"]] = entry["sha"]

    changed, unchanged, new = [], 0, []
    for rel, abspath in files:
        local = git_blob_sha(abspath)
        if rel in remote:
            if remote[rel] == local:
                unchanged += 1
                continue
            changed.append(rel)
        else:
            new.append(rel)
    total = len(files)
    print("local %d files | unchanged %d | modified %d | new %d"
          % (total, unchanged, len(changed), len(new)))
    for rel in changed:
        print("  M  %s" % rel)
    for rel in new:
        print("  A  %s" % rel)
    if not changed and not new:
        print("\nnothing to do -- remote already matches the working tree")
        return

    todo = [(rel, p) for rel, p in files if rel in set(changed) | set(new)]

    def upload(job):
        rel, abspath = job
        payload = {"content": base64.b64encode(open(abspath, "rb").read()).decode("ascii"),
                   "encoding": "base64"}
        sha = call("POST", "/repos/%s/git/blobs" % REPO, payload)["sha"]
        mode = "100755" if rel.endswith(".sh") or os.access(abspath, os.X_OK) else "100644"
        return {"path": rel, "mode": mode, "type": "blob", "sha": sha}

    entries = []
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for entry in pool.map(upload, todo):
            entries.append(entry)
            done += 1
            print("  uploaded %d/%d  %s" % (done, len(todo), entry["path"]))

    new_tree = call("POST", "/repos/%s/git/trees" % REPO,
                    {"base_tree": base_tree_sha, "tree": entries})
    who = call("GET", "/user")
    who["author"] = {"name": who.get("name") or who["login"],
                     "email": who.get("email") or "%s@users.noreply.github.com" % who["login"]}
    who["committer"] = dict(who["author"])
    who["message"] = (
        "Rename to llm-for-zotero-patches; name the extension after the add-on it "
        "extends; rewrite the README around symptoms.\n\n"
        "- repository and extension now say which add-on they patch\n"
        "- README: symptom -> cause -> fix, screenshots placeholder, details folded\n"
        "- new test_readme_claims.js pins every technical number in the README to the\n"
        "  shipped bundle (it had drifted: the agent round cap was documented as 24,\n"
        "  upstream3.9.10 sets 12)\n"
        "- 8 suites / 207 assertions pass"
    )
    who["tree"] = new_tree["sha"]
    who["parents"] = [head["object"]["sha"]]
    commit = call("POST", "/repos/%s/git/commits" % REPO, who)
    call("PATCH", "/repos/%s/git/refs/heads/%s" % (REPO, BRANCH),
         {"sha": commit["sha"], "force": False})
    print("\ncommit %s\napi calls %d\nhttps://github.com/%s/commit/%s"
          % (commit["sha"], _calls, REPO, commit["sha"]))


if __name__ == "__main__":
    main()
