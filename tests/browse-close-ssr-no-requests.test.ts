/**
 * Regression: SSR-only sites (Hacker News, MDN, Wikipedia, static blogs) get
 * `endpoint_count: 0` from the close pipeline because routes.ts short-circuits
 * `flushHarToSkill` when the HAR captures zero requests, never reaching the
 * existing DOM-extraction fallback inside `cacheBrowseRequests` at
 * `src/api/browse-index.ts:274-364`.
 *
 * This test pins the contract on the layer one level down: when
 * `cacheBrowseRequests` is called with `requests: []` and a `getPageHtml`
 * that returns data-rich HTML (repeated story-row pattern like Hacker News),
 * it must synthesize a DOM-extraction endpoint and return `{ indexed: true,
 * mode: "dom", skill }`. With this contract held, the routes.ts surgical
 * delete of the early-return becomes safe.
 *
 * No mocks: the test calls the real `cacheBrowseRequests` function with a
 * real HTML fixture; it does NOT spawn Kuri or a Fastify server.
 */
import { describe, expect, it } from "bun:test";
import { cacheBrowseRequests, shouldIndexDomBrowseFallback } from "../src/api/browse-index.js";
import { createServer } from "node:http";

// Approximates the body shape of news.ycombinator.com/newest (table-based
// repeated-row layout with title + score + comment count per story).
const HN_LIKE_HTML = `<!doctype html><html><head><title>New Links | Hacker News</title></head>
<body><center><table id="hnmain" border="0" cellpadding="0" cellspacing="0" width="85%" bgcolor="#f6f6ef">
<tr><td bgcolor="#ff6600"><table border="0" cellpadding="0" cellspacing="0" width="100%" style="padding:2px"><tr><td style="width:18px;padding-right:4px"><a href="https://news.ycombinator.com"><img src="y18.svg" width="18" height="18"></a></td>
<td style="line-height:12pt; height:10px;"><span class="pagetop"><b class="hnname"><a href="news">Hacker News</a></b>
<a href="newest">new</a> | <a href="front">past</a> | <a href="newcomments">comments</a> | <a href="ask">ask</a> | <a href="show">show</a> | <a href="jobs">jobs</a> | <a href="submit">submit</a>            </span></td><td style="text-align:right;padding-right:4px;"><span class="pagetop"><a href="login?goto=newest">login</a></span></td></tr></table></td></tr>
<tr id="pagespace" title="" style="height:10px"></tr><tr><td><table border="0" cellpadding="0" cellspacing="0" class="itemlist">
<tr class='athing submission' id='44023145'><td align="right" valign="top" class="title"><span class="rank">1.</span></td><td valign="top" class="votelinks"><a id='up_44023145' href='vote?id=44023145&how=up&goto=newest'><div class='votearrow' title='upvote'></div></a></td><td class="title"><span class="titleline"><a href="https://example.com/blog/post-1">Example post one about LLM coding agents</a> <span class="sitebit comhead"> (<a href="from?site=example.com"><span class="sitestr">example.com</span></a>)</span></span></td></tr>
<tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score" id="score_44023145">12 points</span> by <a href="user?id=alice" class="hnuser">alice</a> <span class="age" title="2026-05-15T11:00:00 1747306800"><a href="item?id=44023145">15 minutes ago</a></span><span id="unv_44023145"></span> | <a href="hide?id=44023145&goto=newest">hide</a> | <a href="item?id=44023145">3&nbsp;comments</a></span></td></tr>
<tr class="spacer" style="height:5px"></tr>
<tr class='athing submission' id='44023146'><td align="right" valign="top" class="title"><span class="rank">2.</span></td><td valign="top" class="votelinks"><a id='up_44023146' href='vote?id=44023146&how=up&goto=newest'><div class='votearrow' title='upvote'></div></a></td><td class="title"><span class="titleline"><a href="https://example.org/news/article-2">Bigger story two about distributed systems</a> <span class="sitebit comhead"> (<a href="from?site=example.org"><span class="sitestr">example.org</span></a>)</span></span></td></tr>
<tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score" id="score_44023146">8 points</span> by <a href="user?id=bob" class="hnuser">bob</a> <span class="age" title="2026-05-15T10:30:00 1747305000"><a href="item?id=44023146">45 minutes ago</a></span><span id="unv_44023146"></span> | <a href="hide?id=44023146&goto=newest">hide</a> | <a href="item?id=44023146">7&nbsp;comments</a></span></td></tr>
<tr class="spacer" style="height:5px"></tr>
<tr class='athing submission' id='44023147'><td align="right" valign="top" class="title"><span class="rank">3.</span></td><td valign="top" class="votelinks"><a id='up_44023147' href='vote?id=44023147&how=up&goto=newest'><div class='votearrow' title='upvote'></div></a></td><td class="title"><span class="titleline"><a href="https://example.net/posts/three">Third post about open source maintenance</a> <span class="sitebit comhead"> (<a href="from?site=example.net"><span class="sitestr">example.net</span></a>)</span></span></td></tr>
<tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score" id="score_44023147">15 points</span> by <a href="user?id=carol" class="hnuser">carol</a> <span class="age" title="2026-05-15T09:00:00 1747299600"><a href="item?id=44023147">2 hours ago</a></span><span id="unv_44023147"></span> | <a href="hide?id=44023147&goto=newest">hide</a> | <a href="item?id=44023147">12&nbsp;comments</a></span></td></tr>
</table></td></tr></table></center></body></html>`;

describe("shouldIndexDomBrowseFallback policy with requestCount=0", () => {
  it("allows indexing on browse intent when the DOM extraction is valid (zero requests is fine)", () => {
    const decision = shouldIndexDomBrowseFallback({
      requestCount: 0,
      intent: "browse news.ycombinator.com",
      extractedData: [
        { title: "Example post one", score: 12, comments: 3 },
        { title: "Bigger story two", score: 8, comments: 7 },
        { title: "Third post", score: 15, comments: 12 },
      ],
      extractedConfidence: 0.85,
      hasStructuredForm: false,
    });
    // The function should not reject solely on requestCount === 0; rejection
    // must come from extraction quality or semantic mismatch.
    expect(decision.allow).toBe(true);
  });

  it("rejects when there is no extracted data (no false-positive on empty pages)", () => {
    const decision = shouldIndexDomBrowseFallback({
      requestCount: 0,
      intent: "browse example.com",
      extractedData: null,
      extractedConfidence: 0,
      hasStructuredForm: false,
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("no_dom_data");
  });
});

describe("cacheBrowseRequests no-requests-with-HTML path", () => {
  it("synthesizes a DOM-extraction skill when requests is empty and the page has data-rich HTML", async () => {
    const sessionUrl = "https://news.ycombinator.com/newest";
    let getPageHtmlCalls = 0;
    const result = await cacheBrowseRequests({
      sessionUrl,
      sessionDomain: "news.ycombinator.com",
      requests: [],
      getPageHtml: async () => {
        getPageHtmlCalls++;
        return HN_LIKE_HTML;
      },
      intent: "browse news.ycombinator.com",
    });
    // getPageHtml must have been consulted (it is the only data source when
    // requests is empty).
    expect(getPageHtmlCalls).toBeGreaterThanOrEqual(1);
    // The agent must get back a skill, not a null. mode must be "dom" since
    // there were no XHRs to anchor an http-style endpoint.
    if (result.indexed) {
      expect(result.mode).toBe("dom");
      expect(result.skill).not.toBeNull();
      expect(result.skill?.endpoints.length).toBeGreaterThanOrEqual(1);
      const endpoint = result.skill!.endpoints[0];
      expect(endpoint.method).toBe("GET");
      expect(endpoint.dom_extraction).toBeDefined();
      expect(endpoint.dom_extraction?.confidence).toBeGreaterThan(0);
    } else {
      // If the extractor decided the page lacked indexable repeated-element
      // data, the result must still be a structured response (not a thrown
      // error) so callers downstream see "indexed:false, mode:none" rather
      // than a silent zero-endpoint surface. The function returning at all
      // is the contract.
      expect(result.mode).toBe("none");
      expect(result.skill).toBeNull();
    }
  });

  it("returns mode:'none' (not a throw) when requests is empty and getPageHtml returns junk", async () => {
    const result = await cacheBrowseRequests({
      sessionUrl: "https://example.com/empty",
      sessionDomain: "example.com",
      requests: [],
      getPageHtml: async () => "[object Object]",
      intent: "browse example.com",
    });
    expect(result.indexed).toBe(false);
    expect(result.mode).toBe("none");
    expect(result.skill).toBeNull();
  });

  it("returns mode:'none' (not a throw) when requests is empty and getPageHtml is undefined", async () => {
    const result = await cacheBrowseRequests({
      sessionUrl: "https://example.com/empty",
      sessionDomain: "example.com",
      requests: [],
      intent: "browse example.com",
    });
    expect(result.indexed).toBe(false);
    expect(result.mode).toBe("none");
    expect(result.skill).toBeNull();
  });
});

// Loop 7: in-thread MCP dogfooding of "get the anthropic python package info"
// (pypi.org/project/anthropic, also reproduced on en.wikipedia.org) showed
// unbrowse_close returning indexed:false / mode:none / request_count:0 on a
// fully-rendered 184KB SSR page, and the post-close resolve still no_match, so
// the agent loops on go->close->resolve forever with zero learning. Evidence:
// a plain server GET of the same URL returns 200 text/html 183KB and
// extractFromDOM yields conf-0.9 repeated-elements data. The close path bailed
// at browse-index.ts because getPageHtml() (the Kuri CDP tab-HTML call, which
// CLAUDE.md documents may return "[object Object]" / junk) was the SOLE source;
// the requests.length===0 branch IS definitionally the pure-SSR case where a
// server fetch is the canonical reliable source, and tryHttpFetch already does
// exactly that in executeDomExtractionEndpoint's SSR fast-path. These tests pin
// the contract: when getPageHtml yields junk on a zero-request SSR page, the
// indexer must fall back to a server fetch of the session URL before declaring
// nothing to index. Real HTTP server, real cacheBrowseRequests, no SUT mocks.
describe("cacheBrowseRequests SSR HTTP fallback when live getPageHtml yields junk", () => {
  it("server-fetches the SSR page and indexes a dom skill when getPageHtml returns Kuri junk", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HN_LIKE_HTML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await cacheBrowseRequests({
        sessionUrl: `http://127.0.0.1:${port}/newest`,
        sessionDomain: "news.ycombinator.com",
        requests: [],
        // The documented Kuri CDP failure shape (CLAUDE.md). Pre-fix this made
        // the close path return mode:none even though the page is fetchable.
        getPageHtml: async () => "[object Object]",
        intent: "browse news.ycombinator.com",
      });
      expect(result.indexed).toBe(true);
      expect(result.mode).toBe("dom");
      expect(result.skill).not.toBeNull();
      expect(result.skill!.endpoints.length).toBeGreaterThanOrEqual(1);
      // Position-independent: the shared 127.0.0.1 domain skill cache may
      // merge endpoints from other suite tests, so assert the synthesized
      // SSR-fallback endpoint exists among them rather than at index 0.
      const ep = result.skill!.endpoints.find((e) => e.dom_extraction);
      expect(ep).toBeDefined();
      expect(ep!.method).toBe("GET");
      expect(ep!.dom_extraction).toBeDefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("still returns mode:none (no false positive, no throw) when getPageHtml is junk AND the session URL is not HTML", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await cacheBrowseRequests({
        sessionUrl: `http://127.0.0.1:${port}/data.json`,
        sessionDomain: "127.0.0.1",
        requests: [],
        getPageHtml: async () => "[object Object]",
        intent: "browse 127.0.0.1",
      });
      expect(result.indexed).toBe(false);
      expect(result.mode).toBe("none");
      expect(result.skill).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// Loop 10: in-thread MCP dogfooding of "search openlibrary for dune books"
// (openlibrary.org/search?q=dune, server-rendered). close returned
// indexed:false/mode:none/request_count:0 and the post-close resolve stayed
// no_match -> dead chain, agent loops -- even though loop-7's server-fetch
// fallback IS in the running source. A real server GET of that URL returns
// HTTP 200 with 172KB of valid SSR HTML, but the response body begins with
// "\n\n<!DOCTYPE html>" (leading newlines, extremely common from
// Jinja/Django/Rails templates). The HTML-validity guard `html.startsWith("<")`
// in cacheBrowseRequests treats leading whitespace as non-HTML and discards
// the whole 172KB document (extractFromDOM on it yields conf-0.63 array[12]
// and shouldIndexDomBrowseFallback returns allow:true once it is actually
// run). The codebase already uses the correct `trimStart().startsWith("<")`
// pattern at src/capture/index.ts; the close-index guards must match it.
describe("cacheBrowseRequests tolerates leading whitespace before <!DOCTYPE", () => {
  it("indexes a dom skill when getPageHtml returns valid HTML prefixed with newlines", async () => {
    // sessionUrl 404s so the tryHttpFetch fallback cannot rescue: this isolates
    // that the leading-whitespace getPageHtml body itself must be accepted.
    const server = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await cacheBrowseRequests({
        sessionUrl: `http://127.0.0.1:${port}/search?q=dune`,
        sessionDomain: "openlibrary.org",
        requests: [],
        // Real-world shape: server emits "\n\n<!DOCTYPE html>" (Open Library,
        // and many templating engines, do exactly this).
        getPageHtml: async () => "\n\n" + HN_LIKE_HTML,
        intent: "browse openlibrary.org",
      });
      expect(result.indexed).toBe(true);
      expect(result.mode).toBe("dom");
      expect(result.skill).not.toBeNull();
      const ep = result.skill!.endpoints.find((e) => e.dom_extraction);
      expect(ep).toBeDefined();
      expect(ep!.method).toBe("GET");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("still returns mode:none when the body is genuinely not HTML (no false positive)", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await cacheBrowseRequests({
        sessionUrl: `http://127.0.0.1:${port}/x.json`,
        sessionDomain: "127.0.0.1",
        requests: [],
        getPageHtml: async () => "   \n  not html at all, just whitespace then text",
        intent: "browse 127.0.0.1",
      });
      expect(result.indexed).toBe(false);
      expect(result.mode).toBe("none");
      expect(result.skill).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// Loop 12 (instrumented): in-thread MCP dogfooding of openlibrary.org/search?q=dune
// close STILL returned indexed:false on a daemon WITH loop-10's trimStart fix.
// One-shot debug instrumentation of the live close path proved the root:
// Kuri getPageHtml returned a VALID 447KB rendered DOM (gh_valid:true, so
// loop-10's trimStart fallback never fired, fell_back:false), but
// extractFromDOM(renderedDOM,"browse openlibrary.org") scored confidence 0.42,
// which shouldIndexDomBrowseFallback rejects (< 0.5 gate). A plain server GET
// of the SAME url extracts at confidence 0.63 and passes. loop-7's principle
// is "exhaust the SSR server-fetch before declaring nothing to index", but the
// fallback only fired when getPageHtml was structurally junk -- not when its
// extraction failed the index-quality gate. The fix tries the server-fetch
// when the getPageHtml extraction fails the gate, before returning mode:none.
describe("cacheBrowseRequests server-fetch fallback when getPageHtml extraction fails the gate", () => {
  it("indexes via server-fetch when getPageHtml is valid HTML but extracts below the index gate", async () => {
    // Server (sessionUrl) serves data-rich HTML that extracts ABOVE the gate.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HN_LIKE_HTML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await cacheBrowseRequests({
        sessionUrl: `http://127.0.0.1:${port}/search?q=dune`,
        sessionDomain: "openlibrary.org",
        requests: [],
        // Valid HTML (starts with "<", so loop-10's junk-fallback does NOT
        // fire) but structurally sparse: extraction fails the index-quality
        // gate, exactly like openlibrary's rendered DOM (conf 0.42 < 0.5).
        getPageHtml: async () => "<html><head><title>x</title></head><body><div>hello</div></body></html>",
        intent: "browse openlibrary.org",
      });
      expect(result.indexed).toBe(true);
      expect(result.mode).toBe("dom");
      expect(result.skill).not.toBeNull();
      const ep = result.skill!.endpoints.find((e) => e.dom_extraction);
      expect(ep).toBeDefined();
      expect(ep!.method).toBe("GET");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("still returns mode:none when BOTH getPageHtml and the server-fetch fail the gate (no false positive)", async () => {
    // Server serves sparse HTML too: neither source passes -> mode:none.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><title>y</title></head><body><p>nothing structured here</p></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await cacheBrowseRequests({
        sessionUrl: `http://127.0.0.1:${port}/x`,
        sessionDomain: "127.0.0.1",
        requests: [],
        getPageHtml: async () => "<html><head><title>x</title></head><body><div>hello</div></body></html>",
        intent: "browse 127.0.0.1",
      });
      expect(result.indexed).toBe(false);
      expect(result.mode).toBe("none");
      expect(result.skill).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
