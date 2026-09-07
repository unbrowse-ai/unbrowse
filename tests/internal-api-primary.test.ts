/**
 * Internal API as primary — the two halves, guarded.
 *
 * Measured on sites100 before this work (serial, 100 sites, local source):
 * 53 of 81 successful cold settles were scraped HTML (`direct-document`) against
 * 28 internal-API settles, `live-capture` fired ONCE across 100 sites, and cold
 * and warm were identical (53/53) because nothing was learned in between.
 *
 * Two rules have to hold for that to change:
 *   1. once a site IS indexed, the learned internal API beats a cached scrape;
 *   2. the cache that decides cold-vs-warm must obey UNBROWSE_HOME, or a "cold"
 *      run is silently answered from the developer's warm cache and every
 *      measurement taken through it is fiction.
 *
 * Rule 2 is not hypothetical: it is how the first end-to-end witness for this
 * change came back `cache_hit:true` with identical total_ms having executed
 * nothing. That witness was discarded and the bypass fixed first.
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
  cachedResultIsDocument,
  learnedSkillOutranksCachedDocument,
  skillEntryCoversRealApi,
} from "../src/values/internal-api-precedence.js";
import { defaultResolutionCacheDir } from "../src/values/cached-resolution.js";

const URL_ = "https://defillama.com/";
const SKILLS = { "defillama.com": { skillId: "D-I5ys", ts: 1 } };

describe("a learned internal API outranks a cached document", () => {
  test("document-shaped cached results are recognised, top-level or nested", () => {
    expect(cachedResultIsDocument({ source: "direct-document" })).toBe(true);
    expect(cachedResultIsDocument({ source: "dom-fallback" })).toBe(true);
    expect(cachedResultIsDocument({ result: { source: "direct-document" } })).toBe(true);
  });

  test("an internal-API cached result is NOT document-shaped", () => {
    // The fast path exists for these. Invalidating them would be a pure
    // regression: re-executing a route we already have the answer for.
    for (const s of ["direct-fetch", "marketplace", "route-cache", "cache", "execute"]) {
      expect(cachedResultIsDocument({ source: s })).toBe(false);
    }
  });

  test("is total — never throws on junk", () => {
    for (const v of [undefined, null, 0, "", [], {}, { source: 42 }]) {
      expect(cachedResultIsDocument(v)).toBe(false);
      expect(learnedSkillOutranksCachedDocument(URL_, v, SKILLS)).toBe(false);
    }
  });

  test("outranks a scrape once a skill exists for the host", () => {
    expect(learnedSkillOutranksCachedDocument(URL_, { source: "direct-document" }, SKILLS)).toBe(true);
  });

  test("matches the host with and without www.", () => {
    expect(learnedSkillOutranksCachedDocument(
      "https://www.defillama.com/x", { source: "direct-document" }, SKILLS)).toBe(true);
    expect(learnedSkillOutranksCachedDocument(
      "https://defillama.com/x", { source: "direct-document" }, { "www.defillama.com": { skillId: "z" } })).toBe(true);
  });

  test("NEVER invalidates a cached internal-API result, even with a skill indexed", () => {
    expect(learnedSkillOutranksCachedDocument(URL_, { source: "direct-fetch" }, SKILLS)).toBe(false);
  });

  test("fails OPEN when no skill is indexed, or the cache is unreadable", () => {
    // Fail-open matters: a missing/corrupt cache must not start invalidating
    // every document hit and re-executing the whole corpus.
    expect(learnedSkillOutranksCachedDocument(URL_, { source: "direct-document" }, {})).toBe(false);
    expect(learnedSkillOutranksCachedDocument(URL_, { source: "direct-document" }, null)).toBe(false);
    expect(learnedSkillOutranksCachedDocument(URL_, { source: "direct-document" }, undefined)).toBe(false);
  });

  test("a skill for a DIFFERENT host does not outrank this one", () => {
    expect(learnedSkillOutranksCachedDocument(
      "https://example.com/x", { source: "direct-document" }, SKILLS)).toBe(false);
  });

  test("unparseable url is not a decision", () => {
    expect(learnedSkillOutranksCachedDocument("not a url", { source: "direct-document" }, SKILLS)).toBe(false);
  });

  test("marketplace-style API skill outranks a cached document for the same host", () => {
    // The bug: marketplace skills that cover a real API were still losing to
    // the literal URL scrape. Generalise the guard so any skill with a real
    // endpoint (marketplace or local) outranks, not just a locally-indexed one.
    // A skill with endpoints that include a JSON API must beat the scrape.
    const apiSkill = {
      skillId: "marketplace-api",
      ts: 1,
      endpoints: [
        { url_template: "https://defillama.com/api/tvl", response_schema: { type: "object" } },
      ],
    };
    expect(learnedSkillOutranksCachedDocument(
      URL_, { source: "direct-document" },
      { "defillama.com": apiSkill },
    )).toBe(true);
    // Also when the skill is stored nested as `skill: { endpoints }`
    expect(learnedSkillOutranksCachedDocument(
      URL_, { source: "direct-document" },
      { "defillama.com": { skill: { endpoints: apiSkill.endpoints }, ts: 1 } } as unknown as Record<string, unknown>,
    )).toBe(true);
    // Explicit hasRealApi signal also suffices
    expect(learnedSkillOutranksCachedDocument(
      URL_, { source: "direct-document" },
      { "defillama.com": { skillId: "z", hasRealApi: true, ts: 1 } },
    )).toBe(true);
  });

  test("a bare page_fetch / doc-only skill does NOT outrank — direct-document stays honest cold-start", () => {
    // When no real internal API exists for the host, the scrape is the honest
    // cold-start fallback (background discovery is queued so the next call wins
    // as API). A bare page_fetch must not invalidate it.
    const docOnly = {
      skillId: "doc-only",
      ts: 1,
      endpoints: [
        { url_template: "https://defillama.com/", dom_extraction: { extraction_method: "page_fetch" }, response_schema: { type: "string", format: "html" }, description: "fetches the rendered page" },
      ],
    };
    expect(learnedSkillOutranksCachedDocument(
      URL_, { source: "direct-document" },
      { "defillama.com": docOnly },
    )).toBe(false);
    expect(skillEntryCoversRealApi(docOnly)).toBe(false);
    expect(skillEntryCoversRealApi({ skillId: "z", hasRealApi: false, ts: 1 })).toBe(false);
  });

  test("skillEntryCoversRealApi is total and guards endpoint shapes", () => {
    expect(skillEntryCoversRealApi(null)).toBe(false);
    expect(skillEntryCoversRealApi(undefined)).toBe(false);
    expect(skillEntryCoversRealApi({})).toBe(false);
    expect(skillEntryCoversRealApi({ endpoints: [] })).toBe(false);
    expect(skillEntryCoversRealApi({ endpoints: [{ url_template: "https://example.com/api/x", response_schema: { type: "object" } }] })).toBe(true);
    // Mixed: one API + one page_fetch → still covers real API
    expect(skillEntryCoversRealApi({
      endpoints: [
        { url_template: "https://example.com/", dom_extraction: { extraction_method: "page_fetch" }, response_schema: { type: "string", format: "html" }, description: "fetches the rendered page" },
        { url_template: "https://example.com/api/items", response_schema: { type: "object" } },
      ],
    })).toBe(true);
  });
});

describe("U-3: the resolution cache obeys UNBROWSE_HOME", () => {
  const prev = process.env.UNBROWSE_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.UNBROWSE_HOME;
    else process.env.UNBROWSE_HOME = prev;
  });

  test("relocates under UNBROWSE_HOME rather than the real home", () => {
    process.env.UNBROWSE_HOME = "/tmp/unbrowse-u3-probe";
    const dir = defaultResolutionCacheDir();
    expect(dir.startsWith("/tmp/unbrowse-u3-probe")).toBe(true);
    expect(dir.endsWith("resolution-cache")).toBe(true);
  });

  test("two different homes never share a resolution cache", () => {
    process.env.UNBROWSE_HOME = "/tmp/u3-a";
    const a = defaultResolutionCacheDir();
    process.env.UNBROWSE_HOME = "/tmp/u3-b";
    const b = defaultResolutionCacheDir();
    expect(a).not.toBe(b);
  });
});
