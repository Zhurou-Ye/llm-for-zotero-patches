// End-to-end comparison: old behaviour vs the patched search pipeline.
//
// Uses the REAL functions, extracted from the patched bundle at run time. This
// used to `require('./fwa_pure.js')`, a hand-copied snapshot of the patched
// block that had drifted well behind the patches -- the test kept passing while
// asserting against code the add-on no longer contained.
//
// This test hits the live network, so it is not part of the offline suite.
const path = require("path");
const { resolveBundle, extractFwaBlock } = require(
  path.join(__dirname, "..", "..", "..", "zotero-patches", "tests", "bundle_source.js"));
const resolved = resolveBundle(process.argv);
const F = new Function(extractFwaBlock(resolved.source) +
  "\nreturn { fwaCleanQuery, fwaEnrichable, fwaExtractArticle, fwaParseBing, fwaParseSo360, fwaRankSources };")();
console.log("  bundle: " + resolved.origin);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const RAW_QUERY = '逆水寒方承意是谁'; // what the model actually sends

async function get(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal
    });
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Reproduces enrichResults(): fetch real page body, swap it in when it is better.
async function enrich(list, limit) {
  await Promise.all(
    list.slice(0, limit).map(async (s) => {
      if (!s || !s.url || !F.fwaEnrichable(s.url)) return;
      try {
        const html = await get(s.url, 9000);
        const art = F.fwaExtractArticle(html, 8000);
        const body = String((art && art.content) || '').trim();
        if (body.length >= 160) {
          s.content = body;
          if (String((art && art.title) || '').length > 4) s.title = String(art.title);
        }
      } catch (e) {
        /* keep original snippet */
      }
    })
  );
  return list;
}

(async () => {
  console.log('query sent by the model :', JSON.stringify(RAW_QUERY));
  console.log('after fwaCleanQuery     :', JSON.stringify(F.fwaCleanQuery(RAW_QUERY)));
  console.log('');

  // ---------- OLD pipeline: single engine, raw query, no rank, no enrich ----------
  const oldQ = encodeURIComponent(RAW_QUERY);
  const oldHtml = await get(
    'https://cn.bing.com/search?q=' + oldQ + '&count=10&setlang=zh-CN'
  );
  const oldRes = F.fwaParseBing(oldHtml, 10).slice(0, 10);
  const oldTotal = oldRes.reduce((a, x) => a + String(x.content || '').length, 0);
  console.log('=== OLD (before patch) ===');
  console.log(
    '  results %d | total %d chars | avg %d',
    oldRes.length,
    oldTotal,
    Math.round(oldTotal / (oldRes.length || 1))
  );
  oldRes.slice(0, 3).forEach((x, i) =>
    console.log('   [' + i + ']', String(x.content || '').slice(0, 66))
  );

  console.log('');

  // ---------- NEW pipeline ----------
  const cleaned = F.fwaCleanQuery(RAW_QUERY);
  const q = encodeURIComponent(cleaned);
  const perEngine = 10;
  const engines = [
    ['bing-cn', 'https://cn.bing.com/search?q=' + q + '&count=' + perEngine + '&setlang=zh-CN', F.fwaParseBing],
    ['so360', 'https://www.so.com/s?q=' + q, F.fwaParseSo360],
    ['bing', 'https://www.bing.com/search?q=' + q + '&count=' + perEngine, F.fwaParseBing]
  ];
  const runs = await Promise.all(
    engines.map(async ([name, url, parse]) => {
      try {
        return { name, records: parse(await get(url), perEngine) };
      } catch (e) {
        return { name, records: [], err: e.message };
      }
    })
  );
  runs.forEach((r) => console.log('  engine', r.name.padEnd(9), '->', r.records.length, 'results', r.err ? '(ERR ' + r.err + ')' : ''));

  const merged = [];
  const seen = {};
  const maxLen = Math.max(...runs.map((r) => r.records.length));
  for (let rank = 0; rank < maxLen; rank++) {
    for (const r of runs) {
      const rec = r.records[rank];
      if (!rec || seen[rec.url]) continue;
      seen[rec.url] = true;
      merged.push(rec);
    }
  }
  console.log('\n=== NEW (after patch) ===');
  console.log('  merged after de-dup:', merged.length, 'results');

  const ranked = F.fwaRankSources(merged, cleaned);
  await enrich(ranked, 5);
  const out = ranked.slice(0, 10);
  const newTotal = out.reduce((a, x) => a + String(x.content || '').length, 0);
  console.log(
    '  total %d chars | avg %d  (was %d / %d)',
    newTotal,
    Math.round(newTotal / (out.length || 1)),
    oldTotal,
    Math.round(oldTotal / (oldRes.length || 1))
  );
  out.slice(0, 5).forEach((x, i) => {
    const host = (() => {
      try { return new URL(x.url).hostname; } catch (e) { return x.url; }
    })();
    console.log(
      '   [' + i + '] ' + String(String(x.content || '').length).padStart(5) + 'ch ' +
      host.padEnd(22) + '| ' + String(x.title || '').slice(0, 34)
    );
  });
  const first = String(out[0].content || '');
  console.log('\n  top result content preview:');
  console.log('   ', first.slice(0, 240).replace(/\n+/g, ' '));
})();
