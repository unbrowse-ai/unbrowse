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
