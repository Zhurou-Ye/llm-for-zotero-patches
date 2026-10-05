# -*- coding: utf-8 -*-
"""
Patch llmforzotero.js: replace Tavily with a free, key-less web access provider.

Only two call sites are rewritten:
  1. hasTavilyApiKey()                 -> always true (passes isWebAccessToolAvailable gate)
  2. createConfiguredWebAccessProvider -> new FreeWebAccessProvider()

Everything else kept byte-identical.

Locating the target bundle
--------------------------
Resolved in this order, so the script stays runnable outside its original box:

  1. --src / --xhtml command line arguments
  2. $ZOTERO_WORKDIR environment variable
  3. current working directory

Expected layout below that root:
    <root>/zotero-llm-src/xpi/content/scripts/llmforzotero.js
    <root>/zotero-llm-src/xpi/content/preferences.xhtml
    <root>/zotero-llm-src/xpi/prefs.js
"""
import io, os, sys, shutil

ROOT = None
for arg in sys.argv[1:]:
    if arg.startswith("--root="):
        ROOT = arg.split("=", 1)[1]
ROOT = ROOT or os.environ.get("ZOTERO_WORKDIR") or os.getcwd()

SRC = os.path.join(ROOT, "zotero-llm-src", "xpi", "content", "scripts", "llmforzotero.js")
BAK = SRC + ".orig.bak"

PATCH = r"""
  // === BEGIN FREE WEB ACCESS PATCH (no API key required) ===
  var FWA_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  function fwaDecodeEntities(value) {
    return String(value || "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/&ensp;/g, " ").replace(/&emsp;/g, " ").replace(/&thinsp;/g, " ")
      .replace(/&hellip;/g, "...").replace(/&mdash;/g, "-").replace(/&ndash;/g, "-")
      .replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"')
      .replace(/&#x([0-9a-f]+);/gi, function (_m, hex) {
        try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return " "; }
      })
      .replace(/&#(\d+);/g, function (_m, dec) {
        try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return " "; }
      })
      .replace(/&amp;/g, "&")
      .replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, " ");
  }
  function fwaText(html) {
    return fwaDecodeEntities(String(html || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  }
  function fwaPickSnippet(block) {
    var parts = [];
    var re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    var m;
    while ((m = re.exec(block)) !== null) parts.push(fwaText(m[1]));
    parts.sort(function (a, b) { return b.length - a.length; });
    return parts[0] || "";
  }
  function fwaBlockedResultHost(url) {
    return /(^|\/\/)([a-z0-9-]+\.)*(so\.com|bing\.com|duckduckgo\.com|mojeek\.com|google\.com|baidu\.com)(\/|$)/i.test(url);
  }
  function fwaNormalizeResultUrl(raw) {
    if (!raw) return null;
    var href = fwaDecodeEntities(String(raw).trim());
    if (/^\/\//.test(href)) href = "https:" + href;
    if (/[?&]uddg=/i.test(href)) {
      try {
        var decoded = decodeURIComponent((href.match(/[?&]uddg=([^&]+)/i) || [])[1] || "");
        if (decoded) href = decoded;
      } catch (e) { /* keep original */ }
    }
    if (!/^https?:\/\//i.test(href)) return null;
    return href;
  }
  function fwaParseBing(html, max) {
    var out = [];
    var parts = html.split(/<li class="b_algo/i).slice(1);
    for (var i = 0; i < parts.length && out.length < max; i += 1) {
      var part = parts[i];
      var hrefMatch = part.match(/<a\b[^>]*href="([^"]+)"/i);
      var url = fwaNormalizeResultUrl(hrefMatch && hrefMatch[1]);
      if (!url || fwaBlockedResultHost(url)) continue;
      var title = fwaText((part.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || "");
      var snippet = fwaPickSnippet(part);
      if (!title && !snippet) continue;
      out.push({ url: url, title: title, content: snippet });
    }
    return out;
  }
  function fwaParseDuckDuckGo(html, max) {
    var out = [];
    var re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,2000}?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null && out.length < max) {
      var url = fwaNormalizeResultUrl(m[1]);
      if (!url || fwaBlockedResultHost(url)) continue;
      out.push({ url: url, title: fwaText(m[2]), content: fwaText(m[3]) });
    }
    return out;
  }
  function fwaParseMojeek(html, max) {
    var out = [];
    var re = /<a[^>]*class="ob"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,2000}?<p class="s"[^>]*>([\s\S]*?)<\/p>/gi;
    var m;
    while ((m = re.exec(html)) !== null && out.length < max) {
      var url = fwaNormalizeResultUrl(m[1]);
      if (!url || fwaBlockedResultHost(url)) continue;
      out.push({ url: url, title: fwaText(m[2]), content: fwaText(m[3]) });
    }
    return out;
  }
  function fwaParseSo360(html, max) {
    var out = [];
    var parts = html.split(/<li class="res-list/i).slice(1);
    for (var i = 0; i < parts.length && out.length < max; i += 1) {
      var part = parts[i];
      var md = part.match(/data-mdurl="([^"]+)"/i);
      var hrefMatch = part.match(/<h3[^>]*>\s*<a\b[^>]*href="([^"]+)"/i);
      var url = fwaNormalizeResultUrl(md ? md[1] : hrefMatch && hrefMatch[1]);
      if (!url || fwaBlockedResultHost(url)) continue;
      var title = fwaText((part.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || "");
      var snippet = "";
      var snip = part.match(/<span class="res-list-summary"[^>]*>([\s\S]*?)<\/span>/i)
        || part.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/i);
      if (snip) snippet = fwaText(snip[1]);
      if (!snippet) snippet = fwaPickSnippet(part);
      if (!title && !snippet) continue;
      out.push({ url: url, title: title, content: snippet });
    }
    return out;
  }
  function fwaExtractArticle(html, limit) {
    var title = "";
    var metaTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (metaTitle) title = fwaDecodeEntities(metaTitle[1]).trim();
    if (!title) {
      var tagTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (tagTitle) title = fwaDecodeEntities(tagTitle[1]).trim();
    }
    if (typeof DOMParser !== "undefined") {
      var doc = null;
      try { doc = new DOMParser().parseFromString(html, "text/html"); } catch (e) { doc = null; }
      if (doc) {
        try {
          var junk = doc.querySelectorAll("script,style,noscript,iframe,svg,nav,header,footer,aside,form,figure,picture,template,button,select,option");
          for (var i = 0; i < junk.length; i += 1) junk[i].remove();
          var og = doc.querySelector("meta[property='og:title']");
          if (og) {
            var content = og.getAttribute("content");
            if (content) title = fwaDecodeEntities(content).trim();
          }
          var root = doc.querySelector("article") || doc.querySelector("main") || doc.querySelector("[role='main']") || doc.body;
          if (root) {
            var nodes = root.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,dd");
            var chunks = [];
            for (var j = 0; j < nodes.length; j += 1) {
              var piece = (nodes[j].textContent || "").replace(/\s+/g, " ").trim();
              if (piece.length >= 2) chunks.push(piece);
              if (chunks.join(" ").length > limit * 2) break;
            }
            var bodyText = chunks.join("\n\n");
            if (!bodyText.trim()) bodyText = (root.textContent || "").replace(/\s+/g, " ").trim();
            return { title: title, content: bodyText.slice(0, limit) };
          }
        } catch (e) { /* fall through to regex path */ }
      }
    }
    var body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
    var mainMatch = body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i);
    if (mainMatch) body = mainMatch[0];
    var chunks2 = [];
    var pRe = /<(p|li|h1|h2|h3|h4|pre|blockquote|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    var m2;
    while ((m2 = pRe.exec(body)) !== null) {
      var chunk = fwaText(m2[2]);
      if (chunk.length >= 2) chunks2.push(chunk);
      if (chunks2.join(" ").length > limit * 2) break;
    }
    var fallbackText = chunks2.join("\n\n") || fwaText(body);
    return { title: title, content: fallbackText.slice(0, limit) };
  }

  function fwaModeRef() {
    try {
      var base = String(config.prefsPrefix || "");
      if (base) return base + ".webSearchProvider";
    } catch (e) { /* ignore */ }
    return "extensions.zotero.llmforzotero.webSearchProvider";
  }
  function getWebSearchProviderMode() {
    try {
      var raw = String(Zotero.Prefs.get(fwaModeRef(), true) || "").trim().toLowerCase();
      if (raw === "tavily" || raw === "free") return raw;
    } catch (e) { /* ignore */ }
    return "auto";
  }
  function setWebSearchProviderMode(value) {
    var raw = String(value || "").trim().toLowerCase();
    try {
      Zotero.Prefs.set(fwaModeRef(), raw === "tavily" || raw === "free" ? raw : "auto", true);
    } catch (e) { /* ignore */ }
  }
  function fwaResolveWebMode() {
    var mode = getWebSearchProviderMode();
    var key = getTavilyApiKey();
    if (mode === "free") return "free";
    if (mode === "tavily") return "tavily";
    return key ? "tavily" : "free";
  }
  var FreeWebAccessProvider = class {
    async httpGet(url, signal) {
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
      }
      if (signal && signal.aborted) throw new WebAccessError("Web request was cancelled.", "cancelled");
      if (!text) throw new WebAccessError("The web resource returned an empty response.", "service");
      return text;
    }

    async search(request) {
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
    }

    async read(request) {
      var pages = [];
      var failedResults = [];
      var urls = request.urls || [];
      for (var i = 0; i < urls.length; i += 1) {
        if (request.signal && request.signal.aborted) {
          throw new WebAccessError("Web request was cancelled.", "cancelled");
        }
        try {
          var url = normalizePublicWebUrl(urls[i]);
          var html = await this.httpGet(url, request.signal);
          var extracted = fwaExtractArticle(html, 12e3);
          pages.push(normalizeSource({ url: url, title: extracted.title, raw_content: extracted.content }, "raw_content"));
        } catch (error) {
          failedResults.push({
            url: String(urls[i] || ""),
            error: normalizeDisplayText2(error && error.message, 500) || "Page could not be extracted."
          });
        }
      }
      if (!pages.length) {
        throw failedResults.length && failedResults[0].error
          ? new WebAccessError(failedResults[0].error, "service")
          : new WebAccessError("No web pages could be read.", "service");
      }
      return {
        provider: "free-web",
        query: request.query,
        depth: request.depth,
        pages: pages,
        failedResults: failedResults,
        usage: normalizeUsage({ credits: 0 })
      };
    }

    async getUsage() {
      return {
        provider: "free-web",
        plan: "Free (no API key)",
        credential: { usage: 0, limit: 0 },
        monthly: { usage: 0, limit: 0 },
        breakdown: { searchCredits: 0, readCredits: 0 },
        payAsYouGo: { usage: 0, limit: 0 }
      };
    }
  };
  // === END FREE WEB ACCESS PATCH ===

"""

ANCHOR = "  // src/webAccess/prefs.ts\n"
OLD_HAS_KEY = """  function hasTavilyApiKey() {
    return Boolean(getTavilyApiKey());
  }
"""
# auto -> Tavily when a key is present, else the free engines.
# tavily -> always Tavily (missing key keeps web tools unavailable, as upstream).
# free -> always the free engines, ignore the Tavily key entirely.
NEW_HAS_KEY = """  function hasTavilyApiKey() {
    if (getWebSearchProviderMode() === "tavily") return Boolean(getTavilyApiKey());
    return true;
  }
"""
OLD_FACTORY = """  function createConfiguredWebAccessProvider() {
    return new TavilyClient(getTavilyApiKey());
  }
"""
NEW_FACTORY = """  function createConfiguredWebAccessProvider() {
    var resolved = fwaResolveWebMode();
    if (resolved === "tavily") return new TavilyClient(getTavilyApiKey());
    return new FreeWebAccessProvider();
  }
"""

# --- preferences UI: add a provider picker next to the Tavily key field ---
OLD_UI_ELEMENT = """    const tavilyKeyLink = doc.querySelector(
      `#${config.addonRef}-tavily-key-link`
    );
"""
NEW_UI_ELEMENT = """    const tavilyKeyLink = doc.querySelector(
      `#${config.addonRef}-tavily-key-link`
    );
    const webProviderSelect = doc.querySelector(
      `#${config.addonRef}-web-provider`
    );
    const webProviderHint = doc.querySelector(
      `#${config.addonRef}-web-provider-hint`
    );
"""

OLD_UI_BIND = """    if (tavilyKeyLink) {
      tavilyKeyLink.addEventListener("click", (event) => {
        event.preventDefault();
        Zotero.launchURL("https://app.tavily.com");
      });
    }
"""
NEW_UI_BIND = """    if (webProviderSelect) {
      const syncWebProviderHint = () => {
        if (!webProviderHint) return;
        const effective = fwaResolveWebMode();
        webProviderHint.textContent = effective === "tavily"
          ? "Now using Tavily with the saved API key."
          : "Now using the free engines: Bing -> 360 Search -> DuckDuckGo -> Mojeek. No API key needed.";
      };
      webProviderSelect.value = getWebSearchProviderMode();
      syncWebProviderHint();
      webProviderSelect.addEventListener("change", () => {
        setWebSearchProviderMode(webProviderSelect.value);
        webProviderSelect.value = getWebSearchProviderMode();
        syncWebProviderHint();
      });
    }
    if (tavilyKeyLink) {
      tavilyKeyLink.addEventListener("click", (event) => {
        event.preventDefault();
        Zotero.launchURL("https://app.tavily.com");
      });
    }
"""

OLD_UI_SUMMARY = """          tavilyApiKeyInput?.value.trim() ? t("Web search on") : t("Web search off")"""
NEW_UI_SUMMARY = """          getTavilyApiKey() || getWebSearchProviderMode() !== "tavily"
            ? t("Web search on")
            : t("Web search off")"""

# --- preferences.xhtml: insert the provider picker above the API key field ---
XHTML = os.path.join(ROOT, "zotero-llm-src", "xpi", "content", "preferences.xhtml")
XHTML_BAK = XHTML + ".orig.bak"

XHTML_OLD = """                <html:div class="llm-pref-field">
                  <html:label for="llmforzotero-tavily-api-key"
                    >API key</html:label
                  >"""
XHTML_NEW = """                <html:div class="llm-pref-field">
                  <html:label for="llmforzotero-web-provider">
                    Search provider
                  </html:label>
                  <html:div class="llm-pref-control">
                    <html:select
                      id="llmforzotero-web-provider"
                      class="llm-pref-select"
                    >
                      <html:option value="auto">Auto (Tavily when a key is set, otherwise free)</html:option>
                      <html:option value="tavily">Tavily only</html:option>
                      <html:option value="free">Free engines only (no API key)</html:option>
                    </html:select>
                    <html:span
                      id="llmforzotero-web-provider-hint"
                      class="llm-pref-hint"
                    ></html:span>
                  </html:div>
                </html:div>
                <html:div class="llm-pref-field">
                  <html:label for="llmforzotero-tavily-api-key"
                    >API key</html:label
                  >"""

# Agent mode ships disabled by default, which short-circuits the whole tool
# pipeline before any tool is ever offered to the model. Flip the default so the
# user's explicit preference still wins, but "unset" now means "on".
OLD_AGENT_MODE = """  function getAgentModeEnabled() {
    return getBoolPref("enableAgentMode", false);
  }
"""
NEW_AGENT_MODE = """  function getAgentModeEnabled() {
    return getBoolPref("enableAgentMode", true);
  }
"""

# --- plugin default prefs: expose the new key with a sensible default ---
DEFAULTS = os.path.join(ROOT, "zotero-llm-src", "xpi", "prefs.js")
DEFAULTS_BAK = DEFAULTS + ".orig.bak"
PREFS_OLD = 'pref("extensions.zotero.llmforzotero.tavilyApiKey", "");\n'
PREFS_NEW = PREFS_OLD + 'pref("extensions.zotero.llmforzotero.webSearchProvider", "auto");\n'


def main():
    with io.open(SRC, encoding="utf-8", newline="") as fh:
        code = fh.read()

    original = code

    # Idempotency: re-running must start from pristine upstream, not from our
    # own output. The backup is only trustworthy if it was taken from an
    # UNPATCHED bundle -- so create it before writing anything, and never let a
    # backup made from an already-patched file stand in for the original.
    #
    # The previous order was: copy SRC to BAK, *then* notice the patch marker
    # and restore from BAK. When the first run happened to start from an
    # already-patched bundle, BAK captured our own output, so every later run
    # restored text containing NEW_* and then failed looking for OLD_* --
    # "FAIL: tavily row summary not found", on a bundle that was fine. Stale
    # backups are therefore discarded rather than trusted.
    already_patched = "FREE WEB ACCESS PATCH" in code
    if already_patched:
        if os.path.exists(BAK):
            with io.open(BAK, encoding="utf-8", newline="") as fh:
                backup = fh.read()
            # Only reuse the backup when it is genuinely pre-patch.
            if "FREE WEB ACCESS PATCH" not in backup:
                print("already patched -> rebuilding from backup")
                code = backup
                original = code
            else:
                print("stale backup (itself patched) -> ignoring it")
                os.remove(BAK)
        else:
            print("already patched but no clean backup -> cannot restore cleanly")
            sys.exit(
                "FAIL: this bundle already carries the free-web-access patch but no\n"
                "clean pre-patch backup exists, so the patch cannot be re-applied\n"
                "idempotently. Start from a fresh upstream .xpi and re-run."
            )

    if not os.path.exists(BAK):
        shutil.copy2(SRC, BAK)

    if ANCHOR not in code:
        sys.exit("FAIL: anchor for patch insertion not found")
    if OLD_HAS_KEY not in code:
        sys.exit("FAIL: hasTavilyApiKey body not found")
    if OLD_FACTORY not in code:
        sys.exit("FAIL: createConfiguredWebAccessProvider body not found")
    if OLD_AGENT_MODE not in code:
        sys.exit("FAIL: getAgentModeEnabled body not found")
    for anchor, label in ((OLD_UI_ELEMENT, "tavily UI element lookup"),
                          (OLD_UI_BIND, "tavily UI event binding"),
                          (OLD_UI_SUMMARY, "tavily row summary")):
        if anchor not in code:
            sys.exit("FAIL: %s not found" % label)

    code = code.replace(ANCHOR, PATCH + ANCHOR, 1)
    code = code.replace(OLD_HAS_KEY, NEW_HAS_KEY, 1)
    code = code.replace(OLD_FACTORY, NEW_FACTORY, 1)
    code = code.replace(OLD_AGENT_MODE, NEW_AGENT_MODE, 1)
    code = code.replace(OLD_UI_ELEMENT, NEW_UI_ELEMENT, 1)
    code = code.replace(OLD_UI_BIND, NEW_UI_BIND, 1)
    code = code.replace(OLD_UI_SUMMARY, NEW_UI_SUMMARY, 1)

    if code == original:
        sys.exit("FAIL: nothing changed")

    with io.open(SRC, "w", encoding="utf-8", newline="") as fh:
        fh.write(code)

    if not os.path.exists(XHTML_BAK):
        shutil.copy2(XHTML, XHTML_BAK)
    with io.open(XHTML_BAK, encoding="utf-8", newline="") as fh:
        xhtml = fh.read()
    if XHTML_OLD not in xhtml:
        sys.exit("FAIL: preferences.xhtml anchor not found")
    xhtml = xhtml.replace(XHTML_OLD, XHTML_NEW, 1)
    with io.open(XHTML, "w", encoding="utf-8", newline="") as fh:
        fh.write(xhtml)

    if not os.path.exists(DEFAULTS_BAK):
        shutil.copy2(DEFAULTS, DEFAULTS_BAK)
    with io.open(DEFAULTS_BAK, encoding="utf-8", newline="") as fh:
        defaults = fh.read()
    if PREFS_OLD in defaults and "webSearchProvider" not in defaults:
        defaults = defaults.replace(PREFS_OLD, PREFS_NEW, 1)
        with io.open(DEFAULTS, "w", encoding="utf-8", newline="") as fh:
            fh.write(defaults)

    print("patched OK")
    print("  + FreeWebAccessProvider inserted, %d bytes" % len(PATCH))
    print("  + provider picker added to preferences.xhtml")
    print("  ~ hasTavilyApiKey() -> mode-aware")
    print("  ~ createConfiguredWebAccessProvider() -> auto / tavily / free")
    print("  ~ getAgentModeEnabled() -> default true")


if __name__ == "__main__":
    main()
