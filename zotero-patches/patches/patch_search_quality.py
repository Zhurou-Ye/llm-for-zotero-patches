# -*- coding: utf-8 -*-
"""
Stage-2 patch: fix the "search forever, never finds anything" behaviour.

Root cause found by measurement (query: "逆水寒 方承意"):

    provider        avg chars/result  10-result total  1st result content
    --------------------------------------------------------------------------
    Tavily              513               5133       real answer extracted from
                                                     the target page body
    free engines         58                523       "领取成功后，请复制保存好弹窗中的礼包序列码..."

A 10x gap. The free providers returned the *search-result meta description*,
which for Chinese commercial sites is marketing filler. The model sees nothing
useful, calls web_read to dig deeper, web_read hits 403/anti-bot on most of those
sites, fails, and the model rewrites the query. MAX_AGENT_ROUNDS was 24, so the
loop ran for a very long time.

Fixes applied here:
  A. enrichResults()  - after a successful search, fetch the target pages and
                        replace the weak meta snippet with extracted body text.
                        This is what makes Tavily worth paying for; we do it
                        locally for free. Failure is always non-fatal: each page
                        keeps its original snippet if anything goes wrong.
  B. loop brake       - MAX_AGENT_ROUNDS 24 -> 12, and web_read no longer throws
                        a bare exception. After 3 consecutive read failures the
                        tool returns guidance ordering the model to answer from
                        the snippets it already has and stop searching.
  C. diagnostics      - Zotero.debug lines for every engine failure, so a future
                        regression can be diagnosed from Help > Debug Output.

Run AFTER patch_webaccess.py. Idempotent: patch_webaccess.py rebuilds from its
own pristine backup, which removes this patch's marker, so the two stay linear.
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
MARKER = "SEARCH QUALITY PATCH"

# --------------------------------------------------------------------------
# A1. httpGet gains a per-call timeout (needed so enrichment cannot stall).
# --------------------------------------------------------------------------
OLD_HTTPGET_HEAD = '''    async httpGet(url, signal) {
      if (signal && signal.aborted) throw new WebAccessError("Web request was cancelled.", "cancelled");
      var headers = {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "User-Agent": FWA_USER_AGENT,
        "Cache-Control": "no-cache"
      };
      var text = "";
      try {
        if (typeof Zotero !== "undefined" && Zotero.HTTP && typeof Zotero.HTTP.request === "function") {
          var xhr = await Zotero.HTTP.request("GET", url, {
            headers: headers,
            responseType: "text",
            timeout: 30000,
            followRedirects: true
          });
          text = xhr && xhr.responseText !== undefined && xhr.responseText !== null ? xhr.responseText : xhr && xhr.response;
        } else {
          var res = await fetch(url, { method: "GET", headers: headers, redirect: "follow", signal: signal || undefined });
          if (res.status < 200 || res.status >= 300) {
            throw new WebAccessError("Web request failed with HTTP " + res.status + ".", "service", res.status);
          }
          text = await res.text();
        }
      } catch (error) {
        if (signal && signal.aborted) throw new WebAccessError("Web request was cancelled.", "cancelled");
        if (error instanceof WebAccessError) throw error;
        throw new WebAccessError("Could not reach the web resource. Check the network connection.", "network");
      }'''

NEW_HTTPGET_HEAD = '''    async httpGet(url, signal, timeoutMs) {
      if (signal && signal.aborted) throw new WebAccessError("Web request was cancelled.", "cancelled");
      var timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
      var headers = {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "User-Agent": FWA_USER_AGENT,
        "Cache-Control": "no-cache"
      };
      var text = "";
      try {
        if (typeof Zotero !== "undefined" && Zotero.HTTP && typeof Zotero.HTTP.request === "function") {
          var xhr = await Zotero.HTTP.request("GET", url, {
            headers: headers,
            responseType: "text",
            timeout: timeout,
            followRedirects: true
          });
          text = xhr && xhr.responseText !== undefined && xhr.responseText !== null ? xhr.responseText : xhr && xhr.response;
        } else {
          var controller = typeof AbortController === "function" ? new AbortController() : null;
          var timer = null;
          if (controller) {
            timer = setTimeout(function () { controller.abort(); }, timeout);
            if (signal && signal.addEventListener) {
              signal.addEventListener("abort", function () { controller.abort(); });
            }
          }
          try {
            var res = await fetch(url, {
              method: "GET",
              headers: headers,
              redirect: "follow",
              ...controller ? { signal: controller.signal } : {}
            });
            if (res.status < 200 || res.status >= 300) {
              throw new WebAccessError("Web request failed with HTTP " + res.status + ".", "service", res.status);
            }
            text = await res.text();
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      } catch (error) {
        if (signal && signal.aborted) throw new WebAccessError("Web request was cancelled.", "cancelled");
        if (error instanceof WebAccessError) throw error;
        throw new WebAccessError("Could not reach the web resource. Check the network connection.", "network");
      }'''

# --------------------------------------------------------------------------
# A2. helpers + enrichResults(), injected next to the provider class.
# --------------------------------------------------------------------------
ENRICH_PATCH = '''  // === BEGIN SEARCH QUALITY PATCH ===
  // Purpose: search-result meta descriptions are often marketing filler (58 chars
  // avg in measurement vs Tavily's 513). Fetch the target pages and swap in real
  // body text so the model can answer without a second round trip.
  function fwaDebug(message) {
    try {
      if (typeof Zotero !== "undefined" && Zotero.debug) {
        Zotero.debug("[llm-for-zotero free-web] " + message);
      }
    } catch (error) { /* diagnostics must never break the run */ }
  }
  var FWA_READ_FAILURES = Object.create(null);
  function fwaNoteReadFailure(key) {
    var slot = String(key || "global");
    FWA_READ_FAILURES[slot] = (FWA_READ_FAILURES[slot] || 0) + 1;
    return FWA_READ_FAILURES[slot];
  }
  function fwaResetReadFailures(key) {
    delete FWA_READ_FAILURES[String(key || "global")];
  }
  function fwaReadGuidance(count, failureCount) {
    var base = "No readable content could be extracted from " + failureCount + " of the requested page(s). "
      + "Typical causes: bot protection (HTTP 403 on sites such as Baidu Baike), paywalls, JavaScript-only "
      + "pages, or hosts that are unreachable from this network.";
    if (count >= 3) {
      return base + " IMPORTANT - this is consecutive web-read failure #" + count + ". "
        + "Stop searching now. Do NOT call web_search or web_read again. "
        + "Answer the user's question immediately using only the titles and snippets already returned by your "
        + "previous web_search calls, and cite those sources. If they genuinely do not contain the answer, say "
        + "plainly that live page reading is blocked on this network and state exactly what could not be verified. "
        + "Do not apologise repeatedly and do not keep retrying.";
    }
    return base + " Do NOT retry these same URLs. Prefer answering directly from the web_search snippets already "
      + "in this conversation; if you still need detail, issue AT MOST ONE new web_search with broader, more "
      + "generic keywords, then answer from its snippets.";
  }
  function fwaEnrichable(url) {
    return !/(^|\\/\\/)(www\\.)?(cn\\.bing\\.com|bing\\.com|duckduckgo\\.com|mojeek\\.com|google\\.com|baidu\\.com\\/link|www\\.so\\.com)(\\/|$)/i.test(String(url || ""));
  }
  // Models send conversational sentences ("逆水寒方承意是谁"). Measured on Bing,
  // appending "是谁" collapsed the result set to three vendor marketing pages,
  // while the bare entity returned genuinely useful links. Strip the scaffolding.
  function fwaCleanQuery(raw) {
    var original = String(raw || "").trim();
    if (!original) return original;
    var s = original;
    s = s.replace(/^(请告诉我|我想知道|帮我查一下|帮我查|请查一下|查一下|请问|请|帮我|能不能|能否|可以)\\s*/i, "");
    s = s.replace(/^(search\\s+for|what\\s+is|who\\s+is|tell\\s+me\\s+about)\\s+/i, "");
    s = s.replace(/(是谁|是什么|什么意思|怎么样的|怎么样|如何呢|介绍一下呗|请简单介绍|介绍一下|介绍下|有哪些|有什么用)\\s*$/g, "");
    s = s.replace(/[?？。，,、！!；;:："“”‘’（）()]/g, " ");
    s = s.replace(/\\s+/g, " ").trim();
    return s.length >= 2 ? s : original;
  }
  // A single engine's top hits are frequently the vendor's own promo pages.
  // Re-rank merged results so knowledge sources surface first.
  function fwaRankSources(sources, query) {
    var terms = String(query || "").split(/\\s+/).filter(function (t) { return t.length > 1; });
    return sources.map(function (source) {
      var score = 0;
      var host = "";
      var path = "";
      try {
        var parsed = new URL(String(source.url || ""));
        host = String(parsed.hostname || "").toLowerCase();
        path = String(parsed.pathname || "").toLowerCase();
      } catch (error) {
        host = String(source.url || "").toLowerCase();
      }
      var title = String(source.title || "");
      var content = String(source.content || "");
      if (/(wikipedia|wiki\\.|\\bwiki\\b|fandom|baike)/.test(host)) score += 45;
      if (/(zhihu\\.com|douban\\.com|csdn\\.net|jianshu\\.com|zhuanlan|bilibili\\.com|zhidao|wenda)/.test(host)) score += 18;
      if (/(3dm|gamersky|ithome|36kr|toutiao|sogou)/.test(host)) score += 10;
      if (/(^\\/$|^\\/index|download|client|activity|gift|libao|huodong|event|promo|login|register|\\/ad\\/)/.test(path)) score -= 30;
      for (var i = 0; i < terms.length; i += 1) {
        if (title.indexOf(terms[i]) >= 0) score += 14;
      }
      score += Math.min(content.length / 120, 25);
      return { source: source, score: score };
    }).sort(function (a, b) {
      return b.score - a.score;
    }).map(function (entry) {
      return entry.source;
    });
  }
  // === END SEARCH QUALITY PATCH ===
'''

FREE_CLASS_ANCHOR = "  var FreeWebAccessProvider = class {"

ENRICH_METHOD = '''
    // Quality fix: replace weak meta descriptions with extracted page body text.
    // Never fatal - every failure degrades back to the original snippet.
    async enrichResults(results, limit, signal) {
      if (!Array.isArray(results) || !results.length) return results;
      var wanted = Math.max(1, Math.min(Number(limit) || 5, 6));
      var targets = results.slice(0, wanted);
      var self = this;
      await Promise.all(targets.map(async function (source) {
        if (!source || signal && signal.aborted) return;
        var url = String(source.url || "");
        if (!url || !fwaEnrichable(url)) return;
        try {
          var html = await self.httpGet(url, signal, 9000);
          var article = fwaExtractArticle(html, 8000);
          var body = String((article && article.content) || "").trim();
          // Only swap in body text when it is meaningfully longer than the snippet.
          if (body.length >= 160) {
            source.content = body;
            if (article && String(article.title || "").length > 4) {
              source.title = String(article.title);
            }
          }
        } catch (error) {
          fwaDebug("enrich skipped for " + url + ": " + ((error && error.message) || error));
        }
      }));
      return results;
    }
'''

SEARCH_ANCHOR = "    async search(request) {\n      var wanted = Math.max(1, Math.min(Number(request.maxResults) || 5, 10));"

# --------------------------------------------------------------------------
# A3. call enrichResults before returning, and log each engine failure.
# --------------------------------------------------------------------------
OLD_SEARCH_FULL = '''    async search(request) {
      var wanted = Math.max(1, Math.min(Number(request.maxResults) || 5, 10));
      var cleanedQuery = String(request.query || "").trim();
      if (request.includeDomains && request.includeDomains.length) {
        cleanedQuery += " " + request.includeDomains.map(function (domain) { return "site:" + domain; }).join(" OR ");
      }
      if (request.excludeDomains && request.excludeDomains.length) {
        cleanedQuery += " " + request.excludeDomains.map(function (domain) { return "-site:" + domain; }).join(" ");
      }
      var query = encodeURIComponent(cleanedQuery);
      var attempts = [
        { name: "bing-cn", url: "https://cn.bing.com/search?q=" + query + "&count=" + wanted + "&setlang=zh-CN", parse: fwaParseBing },
        { name: "bing", url: "https://www.bing.com/search?q=" + query + "&count=" + wanted, parse: fwaParseBing },
        { name: "bing-alt", url: "https://www4.bing.com/search?q=" + query + "&count=" + wanted, parse: fwaParseBing },
        { name: "so360", url: "https://www.so.com/s?q=" + query, parse: fwaParseSo360 },
        { name: "duckduckgo", url: "https://html.duckduckgo.com/html/?q=" + query + "&kl=cn-zh", parse: fwaParseDuckDuckGo },
        { name: "mojeek", url: "https://www.mojeek.com/search?q=" + query, parse: fwaParseMojeek }
      ];
      var lastError = null;
      var seen = {};
      for (var i = 0; i < attempts.length; i += 1) {
        if (request.signal && request.signal.aborted) {
          throw new WebAccessError("Web request was cancelled.", "cancelled");
        }
        try {
          var html = await this.httpGet(attempts[i].url, request.signal);
          var records = attempts[i].parse(html, wanted);
          var results = [];
          for (var j = 0; j < records.length && results.length < wanted; j += 1) {
            var record = records[j];
            if (seen[record.url]) continue;
            seen[record.url] = true;
            try {
              results.push(normalizeSource(record, "content"));
            } catch (e) { /* invalid url skipped */ }
          }
          if (results.length) {
            return {
              provider: "free-web",
              query: readString2(request.query) || request.query,
              depth: request.depth,
              topic: request.topic,
              results: results,
              usage: normalizeUsage({ credits: 0 })
            };
          }
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new WebAccessError("No free search engine returned results.", "service");
    }'''

NEW_SEARCH_FULL = '''    async search(request) {
      var wanted = Math.max(1, Math.min(Number(request.maxResults) || 5, 10));
      var cleanedQuery = fwaCleanQuery(String(request.query || "").trim());
      if (request.includeDomains && request.includeDomains.length) {
        cleanedQuery += " " + request.includeDomains.map(function (domain) { return "site:" + domain; }).join(" OR ");
      }
      if (request.excludeDomains && request.excludeDomains.length) {
        cleanedQuery += " " + request.excludeDomains.map(function (domain) { return "-site:" + domain; }).join(" ");
      }
      if (request.signal && request.signal.aborted) {
        throw new WebAccessError("Web request was cancelled.", "cancelled");
      }
      var query = encodeURIComponent(cleanedQuery);
      var perEngine = Math.max(wanted, 10);
      // Query every reachable engine concurrently and merge. Measured: no single
      // engine gives good coverage for entity questions, because each vendor puts
      // its own promo pages first.
      var engines = [
        { name: "bing-cn", url: "https://cn.bing.com/search?q=" + query + "&count=" + perEngine + "&setlang=zh-CN", parse: fwaParseBing },
        { name: "so360", url: "https://www.so.com/s?q=" + query, parse: fwaParseSo360 },
        { name: "bing", url: "https://www.bing.com/search?q=" + query + "&count=" + perEngine, parse: fwaParseBing },
        { name: "bing-alt", url: "https://www4.bing.com/search?q=" + query + "&count=" + perEngine, parse: fwaParseBing },
        { name: "duckduckgo", url: "https://html.duckduckgo.com/html/?q=" + query + "&kl=cn-zh", parse: fwaParseDuckDuckGo },
        { name: "mojeek", url: "https://www.mojeek.com/search?q=" + query, parse: fwaParseMojeek }
      ];
      var self = this;
      var lastError = null;
      var runs = await Promise.all(engines.map(async function (engine) {
        if (request.signal && request.signal.aborted) return { name: engine.name, records: [] };
        try {
          var html = await self.httpGet(engine.url, request.signal, 12000);
          return { name: engine.name, records: engine.parse(html, perEngine) };
        } catch (error) {
          lastError = error;
          fwaDebug("engine " + engine.name + " failed: " + ((error && error.message) || error));
          return { name: engine.name, records: [] };
        }
      }));
      // Round-robin interleave, so no single engine's ranking dominates.
      var merged = [];
      var seen = {};
      var maxLen = 0;
      var reached = 0;
      for (var e = 0; e < runs.length; e += 1) {
        if (runs[e].records.length) reached += 1;
        maxLen = Math.max(maxLen, runs[e].records.length);
      }
      for (var rank = 0; rank < maxLen; rank += 1) {
        for (var f = 0; f < runs.length; f += 1) {
          var record = runs[f].records[rank];
          if (!record || seen[record.url]) continue;
          seen[record.url] = true;
          try {
            merged.push(normalizeSource(record, "content"));
          } catch (err) { /* invalid url skipped */ }
        }
      }
      if (!merged.length) {
        fwaDebug("all " + runs.length + " engines failed; last error: " + ((lastError && lastError.message) || lastError));
        throw lastError || new WebAccessError("No free search engine returned results.", "service");
      }
      fwaDebug("merged " + merged.length + " results from " + reached + " live engine(s)");
      merged = fwaRankSources(merged, cleanedQuery);
      try {
        await this.enrichResults(merged, Math.min(wanted, 5), request.signal);
      } catch (error) {
        fwaDebug("enrichResults threw, keeping original snippets: " + ((error && error.message) || error));
      }
      return {
        provider: "free-web",
        query: readString2(request.query) || request.query,
        depth: request.depth,
        topic: request.topic,
        results: merged.slice(0, wanted),
        usage: normalizeUsage({ credits: 0 })
      };
    }'''

OLD_ROUNDS = "      MAX_AGENT_ROUNDS = 24;"
NEW_ROUNDS = "      MAX_AGENT_ROUNDS = 12;"

# --------------------------------------------------------------------------
# B2. web_read: stop throwing bare exceptions, add the escalating brake.
# --------------------------------------------------------------------------
OLD_WEBREAD_EXEC = '''      execute: async (input, context) => {
        if (!context.runId) {
          throw new Error("web_read requires an active local agent run.");
        }
        assertWebReadUrlsFromSearch(context.runId, input.urls);
        const result = await providerFactory().read({
          ...input,
          signal: context.signal
        });
        const pages = applyRunSourceIds(context.runId, result.pages);
        return {
          ...result,
          pages,
          citation: webCitationInstruction(
            pages.map((source) => source.sourceId)
          )
        };
      }'''

NEW_WEBREAD_EXEC = '''      execute: async (input, context) => {
        if (!context.runId) {
          throw new Error("web_read requires an active local agent run.");
        }
        assertWebReadUrlsFromSearch(context.runId, input.urls);
        let result = null;
        let readError = null;
        try {
          result = await providerFactory().read({
            ...input,
            signal: context.signal
          });
        } catch (error) {
          readError = error;
        }
        const rawPages = (result && result.pages) || [];
        const rawFailed = (result && result.failedResults) || [];
        const pages = applyRunSourceIds(context.runId, rawPages);
        if (!pages.length) {
          // Soft failure: return an empty-but-valid result plus escalating
          // guidance instead of an opaque exception, so the model knows what to
          // do next instead of blindly rewriting the query for 24 rounds.
          const streak = fwaNoteReadFailure(context.runId);
          const reason = readError
            ? String((readError && readError.message) || readError)
            : rawFailed.length
              ? rawFailed.map((entry) => String((entry && entry.error) || "")).filter(Boolean).join("; ")
              : "No pages could be extracted.";
          fwaDebug("web_read yielded nothing (streak " + streak + "): " + reason);
          return {
            provider: readError ? "unknown" : (result && result.provider) || "unknown",
            query: input.query,
            pages: [],
            failedResults: rawFailed.length
              ? rawFailed
              : input.urls.map((url) => ({ url: String(url), error: reason })),
            guidance: fwaReadGuidance(streak, input.urls.length),
            error: reason,
            citation: webCitationInstruction([])
          };
        }
        fwaResetReadFailures(context.runId);
        const base = { ...result, pages };
        if (rawFailed.length) base.failedResults = rawFailed;
        return {
          ...base,
          citation: webCitationInstruction(
            pages.map((source) => source.sourceId)
          )
        };
      }'''

def main():
    if not os.path.exists(SRC):
        sys.exit("FAIL: %s not found. Run patch_webaccess.py first." % SRC)
    if "FREE WEB ACCESS PATCH" not in io.open(SRC, encoding="utf-8").read():
        sys.exit("FAIL: stage-1 patch missing. Run patch_webaccess.py first.")

    with io.open(SRC, encoding="utf-8", newline="") as fh:
        code = fh.read()

    if MARKER in code:
        print("already patched (marker present) - aborting to avoid double-application")
        return

    replacements = (
        (OLD_HTTPGET_HEAD, NEW_HTTPGET_HEAD, "httpGet per-call timeout"),
        (FREE_CLASS_ANCHOR, ENRICH_PATCH + FREE_CLASS_ANCHOR, "helpers + brake helpers"),
        (SEARCH_ANCHOR, ENRICH_METHOD + SEARCH_ANCHOR, "enrichResults method"),
        (OLD_SEARCH_FULL, NEW_SEARCH_FULL, "search: clean query + concurrent merge + re-rank"),
        (OLD_ROUNDS, NEW_ROUNDS, "MAX_AGENT_ROUNDS 24 -> 12"),
        (OLD_WEBREAD_EXEC, NEW_WEBREAD_EXEC, "web_read soft failure + brake"),
    )

    for old, new, label in replacements:
        if old not in code:
            sys.exit("FAIL: anchor not found -> %s" % label)
        if code.count(old) != 1:
            sys.exit("FAIL: anchor not unique (%d) -> %s" % (code.count(old), label))
        code = code.replace(old, new, 1)
        print("  ~ %s" % label)

    with io.open(SRC, "w", encoding="utf-8", newline="") as fh:
        fh.write(code)

    nodepath.syntax_check(SRC, label="llmforzotero.js")
    print("  + node --check passed")
    print("patched OK")

if __name__ == "__main__":
    main()
