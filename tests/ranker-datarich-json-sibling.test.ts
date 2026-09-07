import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/client/rank-server-first.js";

// Fix 2 (contract ebc82be0 / parent bf5b9b1e): the usgs probe captured both
// a page-artifact (dom_extraction synthesised from the earthquakes summary
// HTML) AND the real .../summary/2.5_day.geojson feed endpoint. Before this
// fix, the page-artifact's data-rich promotion (`pageArtifactIsDataRich`)
// fired because GeoJSON's `{type:'object', properties:{features:{type:'array',
// items:{...}}}}` schema matches the shallow walker — but the GEOJSON SIBLING
// is the better answer. The fix:
//
//   1. Extends looksLikeApiUrl to cover .geojson, .ndjson, .jsonl, .xml,
//      .atom, .rss in addition to .json.
//   2. Adds hasDataRichJsonSiblingInCorpus — corpus-level flag that walks
//      schemas DEEPLY (oneOf/anyOf/items/properties to depth 8) so nested
//      array shapes are detected.
//   3. When that sibling exists for a LIST_INTENT, the page-artifact is
//      demoted via clampToFloor(PAGE_ARTIFACT_DEMOTION) instead of being
//      promoted.
describe("rankEndpoints data-rich JSON sibling beats page-artifact", () => {
  test("usgs .geojson sibling beats the page-artifact for earthquake list intent", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "page-artifact",
        method: "GET",
        url_template: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
        trigger_url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.85,
        description: "Captured page artifact for list earthquakes",
        dom_extraction: { extraction_method: "spa-nextjs", confidence: 0.9 },
        response_schema: {
          type: "object",
          properties: {
            features: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        },
      } as any,
      {
        endpoint_id: "geojson-sibling",
        method: "GET",
        url_template: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Real geojson earthquake feed",
        response_schema: {
          // GeoJSON FeatureCollection shape exactly as inferSchema emits it.
          type: "object",
          properties: {
            type: { type: "string" },
            metadata: { type: "object", properties: { count: { type: "number" } } },
            features: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  geometry: { type: "object" },
                  properties: {
                    type: "object",
                    properties: {
                      mag: { type: "number" },
                      place: { type: "string" },
                      time: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    ], "list earthquakes usgs", "earthquake.usgs.gov", "https://earthquake.usgs.gov/earthquakes/");

    const idxPage = ranked.findIndex((r) => r.endpoint.endpoint_id === "page-artifact");
    const idxGeo = ranked.findIndex((r) => r.endpoint.endpoint_id === "geojson-sibling");
    expect(idxPage).toBeGreaterThan(-1);
    expect(idxGeo).toBeGreaterThan(-1);
    // Real geojson sibling beats the synthesised page-artifact.
    expect(idxGeo).toBeLessThan(idxPage);
  });

  test("detects array nested inside oneOf/anyOf branches via deep walker", () => {
    // Construct a corpus where the API sibling's schema places the array
    // inside a `oneOf` branch (some legacy APIs publish ResponseV1 union
    // ResponseV2 alternatives). The shallow walker would have missed this;
    // the deep walker reaches array at depth 2.
    const ranked = rankEndpoints([
      {
        endpoint_id: "page-artifact",
        method: "GET",
        url_template: "https://example.com/list",
        trigger_url: "https://example.com/list",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.85,
        description: "Captured page artifact for list items",
        dom_extraction: { extraction_method: "spa-nextjs", confidence: 0.9 },
        response_schema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "object" } },
          },
        },
      } as any,
      {
        endpoint_id: "api-sibling-with-oneof",
        method: "GET",
        url_template: "https://api.example.com/v1/items.json",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Items API (versioned response)",
        response_schema: {
          oneOf: [
            { type: "object", properties: { items: { type: "array" } } },
            { type: "object", properties: { error: { type: "string" } } },
          ],
        },
      } as any,
    ], "list items example", "example.com", "https://example.com/list");

    const idxPage = ranked.findIndex((r) => r.endpoint.endpoint_id === "page-artifact");
    const idxApi = ranked.findIndex((r) => r.endpoint.endpoint_id === "api-sibling-with-oneof");
    expect(idxPage).toBeGreaterThan(-1);
    expect(idxApi).toBeGreaterThan(-1);
    expect(idxApi).toBeLessThan(idxPage);
  });

  test("looksLikeApiUrl now recognises .geojson, .atom, .rss extensions", () => {
    // Corpus with .atom + .rss data feeds vs a page-artifact. With the
    // pre-fix shallow extension list (only .json), the feeds did not even
    // qualify as `looksLikeApiUrl` so they couldn't beat the page-artifact
    // at any rule. After the fix, both feeds are real API siblings.
    const ranked = rankEndpoints([
      {
        endpoint_id: "page-artifact",
        method: "GET",
        url_template: "https://news.example.com/latest",
        trigger_url: "https://news.example.com/latest",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.85,
        description: "Captured page artifact for news feed",
        dom_extraction: { extraction_method: "spa-nextjs", confidence: 0.9 },
        response_schema: {
          type: "object",
          properties: {
            articles: { type: "array", items: { type: "object" } },
          },
        },
      } as any,
      {
        endpoint_id: "atom-feed",
        method: "GET",
        url_template: "https://news.example.com/feed.atom",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Atom feed of latest articles",
        response_schema: {
          type: "object",
          properties: {
            entries: { type: "array", items: { type: "object" } },
          },
        },
      } as any,
    ], "latest news feed example", "news.example.com", "https://news.example.com/latest");

    const idxPage = ranked.findIndex((r) => r.endpoint.endpoint_id === "page-artifact");
    const idxAtom = ranked.findIndex((r) => r.endpoint.endpoint_id === "atom-feed");
    expect(idxPage).toBeGreaterThan(-1);
    expect(idxAtom).toBeGreaterThan(-1);
    expect(idxAtom).toBeLessThan(idxPage);
  });
});

// Direct unit-test of the schema walker primitive.
describe("schemaContainsArrayAtAnyDepth (deep walker primitive)", () => {
  // Re-import the helper indirectly by calling rankEndpoints in shapes that
  // exercise the walker. The walker is non-exported so we drive it via the
  // observable behavior above (sibling-beats-page). A direct expectation on
  // the helper itself would require an export; the integration test above
  // is the load-bearing falsifier.
  test("synthetic sanity — array-at-depth shapes are sibling-eligible", () => {
    const ranked = rankEndpoints([
      {
        endpoint_id: "page-artifact",
        method: "GET",
        url_template: "https://example.com/deep",
        trigger_url: "https://example.com/deep",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.85,
        description: "Captured page artifact for deep list",
        dom_extraction: { extraction_method: "spa-nextjs", confidence: 0.9 },
        response_schema: {
          type: "object",
          properties: {
            data: { type: "array", items: { type: "object" } },
          },
        },
      } as any,
      {
        endpoint_id: "api-deep-array",
        method: "GET",
        url_template: "https://api.example.com/v1/records.json",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Records API with deeply nested array property",
        response_schema: {
          type: "object",
          properties: {
            payload: {
              type: "object",
              properties: {
                level2: {
                  type: "object",
                  properties: {
                    records: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      } as any,
    ], "list records example", "example.com", "https://example.com/deep");

    const idxPage = ranked.findIndex((r) => r.endpoint.endpoint_id === "page-artifact");
    const idxApi = ranked.findIndex((r) => r.endpoint.endpoint_id === "api-deep-array");
    expect(idxApi).toBeLessThan(idxPage);
  });
});
