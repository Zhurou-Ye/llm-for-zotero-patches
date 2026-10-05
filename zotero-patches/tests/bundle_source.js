"use strict";
/**
 * Locate the patched llm-for-zotero bundle for the tests in this folder.
 *
 * The tests need the *patched* `content/scripts/llmforzotero.js`. Where that
 * lives depends on who is running them:
 *
 *   - a contributor who just ran `apply.py --keep` has an extracted tree in
 *     `zotero-patches/.build/`
 *   - everyone else has the shipped artefact, `dist/patched-llm-for-zotero-*.xpi`
 *   - an explicit path always wins: `node test_x.js /path/to/llmforzotero.js`
 *
 * The tests used to default to `../../zotero-dev/...`, a directory that only
 * ever existed on the machine the patches were written on. Anyone who cloned
 * the repository got a bare ENOENT, which reads as "the patch is broken"
 * rather than "you did not point me at a bundle".
 *
 * A .xpi is a zip, so reading the entry out of one needs no dependencies --
 * `unzip` is not available everywhere and neither is a zip library.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const REPO = path.join(__dirname, "..", "..");
const ENTRY = "content/scripts/llmforzotero.js";

function fromXpi(xpiPath) {
  const buf = fs.readFileSync(xpiPath);

  // Read the entry out of the *central directory*, not by scanning local file
  // headers. A local header stores sizes that are only valid when the writer
  // knew them up front; when a general-purpose bit 3 data descriptor is used
  // they are zero and the real length lives in a trailing record, so scanning
  // headers silently computes a zero-length slice. The central directory is
  // authoritative and always written last, so it is parsed here.
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i -= 1) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory): " + xpiPath);

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64
  // end-of-central-directory record.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const locSig = 0x07064b50;
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i -= 1) {
      if (buf.readUInt32LE(i) === locSig) { loc = i; break; }
    }
    if (loc < 0) throw new Error("zip64 locator missing in " + xpiPath);
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (buf.readUInt32LE(z64) !== 0x06064b50) {
      throw new Error("zip64 end-of-central-directory missing in " + xpiPath);
    }
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }

  const cdSig = 0x02014b50;
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== cdSig) {
      throw new Error("corrupt central directory at entry " + n + " in " + xpiPath);
    }
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

    if (name === ENTRY) {
      let compSize = buf.readUInt32LE(p + 20);
      let localOffset = buf.readUInt32LE(p + 42);
      // ZIP64 extended information extra field (header id 0x0001).
      if (compSize === 0xffffffff || localOffset === 0xffffffff) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = buf.readUInt16LE(e);
          const size = buf.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            // Fields appear in a fixed order, each present only when the
            // corresponding 32-bit slot was saturated.
            if (buf.readUInt32LE(p + 24) === 0xffffffff) q += 8; // uncompressed
            if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
            break;
          }
          e += 4 + size;
        }
      }
      // The local header repeats the name/extra with its own lengths, so the
      // payload offset has to be computed from *this* header, not the central
      // one.
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const payload = buf.slice(start, start + compSize);
      if (method === 0) return payload.toString("utf8");
      if (method === 8) return zlib.inflateRawSync(payload).toString("utf8");
      throw new Error("unsupported compression method " + method + " in " + xpiPath);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(ENTRY + " not found in " + xpiPath);
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function listXpis(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".xpi"))
    .map((name) => path.join(dir, name))
    .sort();
}

function resolveBundle(argv) {
  const explicit = argv && argv[2];
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error("no such bundle: " + explicit);
    }
    return { source: fs.readFileSync(explicit, "utf8"), origin: explicit };
  }

  // 1) a kept scratch tree from apply.py --keep
  const built = path.join(REPO, "zotero-patches", ".build", "zotero-llm-src", "xpi", ENTRY);
  const builtHit = firstExisting([built]);
  if (builtHit) {
    return { source: fs.readFileSync(builtHit, "utf8"), origin: builtHit };
  }

  // 2) the shipped artefact
  const distDir = path.join(REPO, "dist");
  const xpis = listXpis(distDir);
  if (!xpis.length) {
    throw new Error(
      "No patched bundle found.\n" +
      "  looked in: " + distDir + "\n" +
      "  Build one with:\n" +
      "    cd zotero-patches && python apply.py --xpi /path/to/llm-for-zotero.xpi " +
      "--out ../dist/patched-llm-for-zotero-<version>.xpi\n" +
      "  or pass a path explicitly:\n" +
      "    node " + path.basename(__filename) + " /path/to/llmforzotero.js"
    );
  }
  const newest = xpis[xpis.length - 1];
  return { source: fromXpi(newest), origin: newest + "!" + ENTRY };
}

// Extract the free-web-access block from a patched bundle.
//
// `fwa_pure.js` used to be a hand-maintained copy of the patched block. It
// drifted: the copy in the repository was less than half the size of the block
// the patches actually inject, so the end-to-end test was asserting against
// stale code while still reporting success. The block is now pulled straight
// out of the built bundle every time, which is the only version that cannot
// drift.
function extractFwaBlock(source) {
  const begin = "// === BEGIN FREE WEB ACCESS PATCH";
  const end = "// === END FREE WEB ACCESS PATCH";
  const a = source.indexOf(begin);
  if (a < 0) throw new Error(begin + " not found -- is this a patched bundle?");
  const b = source.indexOf(end, a);
  if (b < 0) throw new Error(end + " not found");
  return source.slice(a, b + end.length);
}

module.exports = { resolveBundle, fromXpi, extractFwaBlock };
