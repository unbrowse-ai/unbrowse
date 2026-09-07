/**
 * The local endpoint-inference engine (src/capture/reveng-local.ts).
 *
 * unbrowse's premise is "learn a site's internal API routes from real browsing, then
 * replay them". Until this engine existed that inference lived server-side only, and
 * when `/v1/reveng` was unreachable `revengServerFirst` returned an EMPTY list: a real
 * capture this week saw 42/65/39 network entries and downloaded 428 KB from
 * `data.europa.eu/api/hub/search/search`, and published ZERO endpoints because the
 * server answered HTTP 426. Every assertion below is about that not happening again.
 *
 * The fixture (tests/fixtures/captured-traffic.json) is deliberately hostile to the two
 * cheap rules that would otherwise pass this suite without doing any work:
 *
 *   - a `/api/` SUBSTRING rule fails it. Two true data routes carry no `/api/`
 *     (`careers.un.org/ds/filter-search-proto/`, the SSR results page) and three
 *     non-endpoints do (`/api/assets/main.js.map`, `/api/i18n/en.json`,
 *     `analytics.eu-cdn.net/api/v2/collect`).
 *   - an "is it JSON?" rule fails it. The sourcemap, the i18n bundle, the config blob,
 *     the health check, the single-record response and both analytics beacons are all
 *     valid JSON and none of them is a data endpoint.
 *
 * What survives both is the structural rule the engine actually implements: does the
 * RESPONSE decode to a collection of like-shaped records?
 *
 * FALSIFICATION. This suite was checked by breaking the engine in both directions and
 * confirming the right tests — and only the right tests — went red. See the run notes in
 * the task report; the two red sets are disjoint by construction because the "finds it"
 * group asserts presence and the "rejects it" group asserts absence.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  revengLocal,
  findRecordCollection,
  harvestCaptureSecrets,
  decodeJsonBody,
  embeddedJsonBlocks,
} from "../src/capture/reveng-local.js";
import { revengServerFirst } from "../src/capture/reveng-server-first.js";
import { sanitizeForPublish } from "../src/publish/sanitize.js";
import { extractTemplateQueryBindings } from "../src/template-params.js";
import type { RawRequest } from "../src/capture/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";

interface Capture {
  page_url: string;
  final_url: string;
  domain: string;
  requests: RawRequest[];
}
interface Fixture {
  planted_credentials: Record<string, string>;
  captures: Capture[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "captured-traffic.json"), "utf-8"),
);
const [europa, un] = fixture.captures;
const PLANTED = Object.values(fixture.planted_credentials);

function infer(capture: Capture): EndpointDescriptor[] {
  return revengLocal(capture.requests, { pageUrl: capture.page_url, finalUrl: capture.final_url });
}

const europaEndpoints = infer(europa);
const unEndpoints = infer(un);
const allEndpoints = [...europaEndpoints, ...unEndpoints];

const templates = (endpoints: EndpointDescriptor[]): string[] => endpoints.map((e) => e.url_template);
const found = (endpoints: EndpointDescriptor[], needle: string): boolean =>
  endpoints.some((e) => e.url_template.includes(needle));

// ---------------------------------------------------------------------------

describe("the capture is not thrown away — real internal routes are found", () => {
  it("finds data.europa.eu/api/hub/search/search, the 428 KB route that used to be discarded", () => {
    expect(found(europaEndpoints, "/api/hub/search/search")).toBe(true);
  });

  it("finds careers.un.org/api/public/opening/jo-filter/", () => {
    expect(found(unEndpoints, "/api/public/opening/jo-filter/")).toBe(true);
  });

  it("finds a true data route that contains NO '/api/' anywhere — recognised on shape alone", () => {
    expect(found(unEndpoints, "/ds/filter-search-proto/")).toBe(true);
    expect(templates(unEndpoints).some((t) => t.includes("filter-search-proto") && !t.includes("/api/"))).toBe(true);
  });

  it("finds the SSR page whose payload rides in an inert JSON data-block, not an XHR", () => {
    const ssr = unEndpoints.find((e) => e.url_template.includes("/jobsearch/results"));
    expect(ssr).toBeDefined();
    expect(ssr!.dom_extraction?.extraction_method).toBe("spa-embedded-json");
  });

  it("a '/api/' substring rule cannot reproduce this result set — it is wrong in both directions", () => {
    // At least one true endpoint has no /api/ …
    expect(allEndpoints.some((e) => !e.url_template.includes("/api/"))).toBe(true);
    // … and at least one captured /api/ URL is NOT an endpoint.
    const apiUrlsInCapture = [...europa.requests, ...un.requests]
      .map((r) => r.url)
      .filter((u) => u.includes("/api/"));
    expect(apiUrlsInCapture.length).toBeGreaterThan(3);
    const rejectedApiUrls = apiUrlsInCapture.filter(
      (u) => !allEndpoints.some((e) => u.startsWith(e.url_template.split("?")[0])),
    );
    expect(rejectedApiUrls.length).toBeGreaterThan(0);
  });

  it("the collection is found nested, not at the response root", () => {
    const body = europa.requests.find((r) => r.url.includes("/api/hub/search/search") && r.method === "GET")!
      .response_body!;
    const collection = findRecordCollection(decodeJsonBody(body));
    expect(collection).not.toBeNull();
    expect(collection!.path).toEqual(["result", "results"]);
    expect(collection!.count).toBe(80);
    expect(collection!.homogeneity).toBe(1);
    // Matches the live measurement: id, title, description, format, media_type, access_url.
    expect(collection!.fields).toEqual([
      "access_url", "description", "format", "id", "media_type", "title",
    ]);
  });
});

describe("things that are not data endpoints are not learned as data endpoints", () => {
  const notAnEndpoint = (needle: string): void => {
    expect(allEndpoints.some((e) => e.url_template.includes(needle))).toBe(false);
  };

  it("the HTML page a human visits is not an endpoint", () => {
    notAnEndpoint("/data/datasets");
    notAnEndpoint("/jobSearchDescription");
  });

  it("a font is not an endpoint", () => {
    notAnEndpoint(".woff2");
  });

  it("an image, a stylesheet and a script bundle are not endpoints", () => {
    notAnEndpoint(".png");
    notAnEndpoint(".css");
    notAnEndpoint("/assets/js/");
    notAnEndpoint("favicon");
  });

  it("a JS sourcemap is not an endpoint — it carries '/api/' AND parses as JSON", () => {
    notAnEndpoint(".js.map");
    // Its arrays hold strings, not records, so there is no collection to find.
    const map = europa.requests.find((r) => r.url.endsWith(".js.map"))!;
    expect(map.url).toContain("/api/");
    expect(decodeJsonBody(map.response_body)).toBeDefined();
    expect(findRecordCollection(decodeJsonBody(map.response_body))).toBeNull();
  });

  it("an i18n bundle is not an endpoint — '/api/' in the path, valid JSON, flat string map", () => {
    notAnEndpoint("/api/i18n/");
  });

  it("a scalar config blob and a health check are not endpoints", () => {
    notAnEndpoint("/config.json");
    notAnEndpoint("/hub/health");
  });

  it("a response carrying ONE record is not a collection — a net wants many fish", () => {
    notAnEndpoint("/search/datasets/dcat-");
  });

  it("an analytics beacon that POSTs a JSON record collection is not a data endpoint", () => {
    // Its collection is OUTBOUND — sent, not received. Direction is the discriminator,
    // and note it also carries "/api/" in its path.
    notAnEndpoint("analytics.eu-cdn.net");
    const beacon = europa.requests.find((r) => r.url.includes("analytics.eu-cdn.net"))!;
    expect(beacon.url).toContain("/api/");
    expect(findRecordCollection(decodeJsonBody(beacon.request_body))).not.toBeNull(); // outbound collection
    expect(findRecordCollection(decodeJsonBody(beacon.response_body))).toBeNull(); // inbound ack
  });

  it("a CORS preflight is not an endpoint", () => {
    expect(allEndpoints.some((e) => e.method === "OPTIONS")).toBe(false);
  });
});

describe("primary data outranks telemetry", () => {
  it("the beacon whose response DOES echo records is admitted but ranked last", () => {
    // t.metrics-eu.net returns {accepted:[{id,status}×3]} — a genuine record collection,
    // so shape alone cannot reject it. It must lose on evidence: 3 records against 80,
    // and 150 response bytes against a ~5 KB request (it sends far more than it receives).
    const idx = europaEndpoints.findIndex((e) => e.url_template.includes("t.metrics-eu.net"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBe(europaEndpoints.length - 1);
  });

  it("the primary search route is ranked first", () => {
    expect(europaEndpoints[0].url_template).toContain("/api/hub/search/search");
  });

  it("the beacon's confidence is materially below the primary route's", () => {
    const primary = europaEndpoints[0].reliability_score;
    const beacon = europaEndpoints.find((e) => e.url_template.includes("t.metrics-eu.net"))!.reliability_score;
    expect(primary - beacon).toBeGreaterThan(0.1);
  });
});

describe("url_template is templated for reuse, from observed variation", () => {
  const search = () => europaEndpoints.find((e) => e.url_template.includes("/api/hub/search/search"))!;
  const jobs = () => unEndpoints.find((e) => e.url_template.includes("jo-filter"))!;

  it("a paged listing yields ?page={page}, not a frozen ?page=2", () => {
    expect(search().url_template).toContain("page={page}");
    expect(search().url_template).not.toContain("page=2");
    expect(jobs().url_template).toContain("page={page}");
  });

  it("the templated params are readable back by the executor's own binding extractor", () => {
    const bindings = extractTemplateQueryBindings(search().url_template);
    expect(bindings.page).toBe("page");
    expect(bindings.q).toBe("q");
  });

  it("templating is lossless — the observed value survives as the replay default", () => {
    expect(search().query?.page).toBe("2");
    expect(search().query?.q).toBe("climate");
    expect(jobs().query?.limit).toBe("25");
  });

  it("a param observed with only ONE value, never echoed, never numeric, stays literal", () => {
    // `query=engineer` on /ds/filter-search-proto/ was seen once. Templating it would be
    // a guess; the engine only templates on evidence, so this stays part of the route.
    const proto = unEndpoints.find((e) => e.url_template.includes("filter-search-proto"))!;
    expect(proto.url_template).toContain("query=engineer");
    expect(proto.url_template).toContain("page={page}");
  });

  it("a secret-valued query param is templated with NO default — the slot survives, the value does not", () => {
    const facets = europaEndpoints.find((e) => e.url_template.includes("/search/facets"))!;
    expect(facets.url_template).toContain("session_token={session_token}");
    expect(facets.query?.session_token).toBeUndefined();
  });

  it("every emitted template is a parseable absolute URL", () => {
    for (const e of allEndpoints) expect(() => new URL(e.url_template)).not.toThrow();
  });
});

describe("no credential is learned into a route", () => {
  const planted = (blob: string): string[] => PLANTED.filter((secret) => blob.includes(secret));

  it("the fixture really does carry the planted credentials — the guard is not vacuous", () => {
    const captureBlob = JSON.stringify(fixture.captures);
    expect(planted(captureBlob).sort()).toEqual([...PLANTED].sort());
  });

  it("no planted credential value appears anywhere in the inferred descriptors", () => {
    expect(planted(JSON.stringify(allEndpoints))).toEqual([]);
  });

  it("no planted credential survives the publish boundary either", () => {
    expect(planted(JSON.stringify(sanitizeForPublish(allEndpoints)))).toEqual([]);
  });

  it("headers_template and proven_recipe — the two fields that have leaked before — are never emitted", () => {
    for (const e of allEndpoints) {
      expect(e.headers_template).toBeUndefined();
      expect(e.proven_recipe).toBeUndefined();
    }
  });

  it("the fact of auth is reported without the credential", () => {
    const search = europaEndpoints.find((e) => e.url_template.includes("/api/hub/search/search"))!;
    expect(search.semantic?.auth_required).toBe(true);
  });

  it("harvestCaptureSecrets finds the cookie, the bearer and the CSRF token in the capture", () => {
    const secrets = harvestCaptureSecrets(europa.requests);
    expect(secrets).toContain(fixture.planted_credentials.cookie);
    expect(secrets).toContain(fixture.planted_credentials.bearer);
    expect(secrets).toContain(fixture.planted_credentials.csrf);
  });

  it("a descriptor is DROPPED rather than published if a credential somehow survived", () => {
    // Plant the cookie value where nothing redacts it: inside the route's own PATH.
    // Fail-closed means the route disappears, never that it ships with the secret in it.
    const secret = fixture.planted_credentials.cookie;
    const poisoned: RawRequest[] = europa.requests.map((r) =>
      r.url.includes("/api/hub/search/search") && r.method === "GET"
        ? { ...r, url: r.url.replace("/search/search", `/search/${secret}/search`) }
        : r,
    );
    const out = revengLocal(poisoned, { pageUrl: europa.page_url });
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});

describe("the output contract, populated honestly", () => {
  it("every required EndpointDescriptor field is populated on every descriptor", () => {
    for (const e of allEndpoints) {
      expect(typeof e.endpoint_id).toBe("string");
      expect(e.endpoint_id.length).toBeGreaterThan(0);
      expect(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "WS"]).toContain(e.method);
      expect(typeof e.url_template).toBe("string");
      expect(["safe", "unsafe"]).toContain(e.idempotency);
      expect(["verified", "unverified", "failed", "pending", "disabled"]).toContain(e.verification_status);
      expect(typeof e.reliability_score).toBe("number");
      expect(typeof e.semantic?.confidence).toBe("number");
      expect(e.response_schema).toBeDefined();
      expect(e.semantic?.example_fields?.length).toBeGreaterThan(0);
    }
  });

  it("endpoint_id is the repo's stable (method, url_template) hash — so it merges, not duplicates", () => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    for (const e of allEndpoints) {
      const expected = createHash("sha256")
        .update(`${e.method}:${e.url_template}`)
        .digest("base64url")
        .slice(0, 21);
      expect(e.endpoint_id).toBe(expected);
    }
  });

  it("a locally-inferred endpoint never claims to be verified", () => {
    for (const e of allEndpoints) {
      expect(e.verification_status).toBe("unverified");
      expect(e.last_verified_at).toBeUndefined();
      // isVerifiedDurable (src/publish-admission.ts) wants "verified" AND >= 0.9.
      // Local inference must never reach that band.
      expect(e.reliability_score).toBeLessThan(0.9);
      expect(e.reliability_score).toBeGreaterThan(0);
    }
  });

  it("idempotency follows the HTTP method, never an optimistic guess about a POST", () => {
    for (const e of allEndpoints) {
      expect(e.idempotency).toBe(["GET", "HEAD", "OPTIONS"].includes(e.method) ? "safe" : "unsafe");
    }
  });

  it("operation_name is populated where it exists on the type — graphql_info, for a GraphQL POST", () => {
    // src/types/skill.ts:278 — `operation_name` is a field of `graphql_info`, present
    // only when the endpoint IS GraphQL. Read off the wire format, not the URL.
    const gql = unEndpoints.find((e) => e.url_template.endsWith("/graphql"))!;
    expect(gql.graphql_info?.operation_name).toBe("OpeningSearch");
    // and it is NOT invented for non-GraphQL routes
    expect(europaEndpoints.every((e) => e.graphql_info === undefined)).toBe(true);
  });

  it("extraction_method + confidence are populated where they exist on the type — dom_extraction, for HTML", () => {
    // src/types/skill.ts:243 — "When set, endpoint returns HTML — apply DOM extraction
    // with this config". Stamping it on a JSON route would send the executor down a DOM
    // path it does not need, so only the SSR route carries it.
    const ssr = unEndpoints.find((e) => e.url_template.includes("/jobsearch/results"))!;
    expect(ssr.dom_extraction?.extraction_method).toBe("spa-embedded-json");
    expect(typeof ssr.dom_extraction?.confidence).toBe("number");
    expect(europaEndpoints.every((e) => e.dom_extraction === undefined)).toBe(true);
  });

  it("response_schema describes where the collection lives and what a record looks like", () => {
    const search = europaEndpoints.find((e) => e.url_template.includes("/api/hub/search/search"))!;
    const inner = search.response_schema?.properties?.result?.properties?.results;
    expect(inner?.type).toBe("array");
    expect(Object.keys(inner?.items?.properties ?? {}).sort()).toEqual([
      "access_url", "description", "format", "id", "media_type", "title",
    ]);
  });

  it("descriptions and schemas carry field NAMES, never captured values", () => {
    const blob = JSON.stringify(allEndpoints);
    // A record's actual content must not ride along in a description or an example.
    expect(blob).not.toContain("Greenhouse gas emissions");
    expect(blob).not.toContain("dcat-climate-1000-eurostat");
  });
});

describe("determinism", () => {
  it("the same capture twice yields byte-identical output, including order", () => {
    expect(JSON.stringify(infer(europa))).toBe(JSON.stringify(europaEndpoints));
    expect(JSON.stringify(infer(un))).toBe(JSON.stringify(unEndpoints));
  });

  it("reordering nothing and re-reading the fixture from disk changes nothing", () => {
    const reread: Fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "captured-traffic.json"), "utf-8"),
    );
    expect(JSON.stringify(infer(reread.captures[0]))).toBe(JSON.stringify(europaEndpoints));
  });
});

describe("degenerate input never throws", () => {
  it("empty input returns []", () => {
    expect(revengLocal([])).toEqual([]);
    expect(revengLocal(undefined as unknown as RawRequest[])).toEqual([]);
  });

  it("malformed entries return [] rather than crashing a capture", () => {
    const junk = [
      { url: "not a url", method: "GET", request_headers: {}, response_status: 200, response_headers: {}, timestamp: "" },
      { url: "https://x.test/a", method: "GET", request_headers: {}, response_status: 200, response_headers: {}, response_body: "{", timestamp: "" },
    ] as RawRequest[];
    expect(revengLocal(junk)).toEqual([]);
  });

  it("a 400KB-shaped body is inferred in well under a second", () => {
    const start = performance.now();
    infer(europa);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("the seam: revengServerFirst falls back instead of returning []", () => {
  it("with no server reachable, the capture yields endpoints rather than being discarded", async () => {
    // UNBROWSE_LOCAL_ONLY short-circuits before any fetch (src/client/index.ts:47), so
    // this exercises the real seam with no network and no module mocking.
    const previous = process.env.UNBROWSE_LOCAL_ONLY;
    process.env.UNBROWSE_LOCAL_ONLY = "1";
    try {
      const out = await revengServerFirst(europa.requests, undefined, {
        pageUrl: europa.page_url,
        finalUrl: europa.final_url,
      });
      expect(out.length).toBeGreaterThan(0);
      expect(out.some((e) => e.url_template.includes("/api/hub/search/search"))).toBe(true);
      expect(JSON.stringify(out)).toBe(JSON.stringify(europaEndpoints));
    } finally {
      if (previous === undefined) delete process.env.UNBROWSE_LOCAL_ONLY;
      else process.env.UNBROWSE_LOCAL_ONLY = previous;
    }
  });

  it("an empty capture is still empty — the fallback invents nothing", async () => {
    const previous = process.env.UNBROWSE_LOCAL_ONLY;
    process.env.UNBROWSE_LOCAL_ONLY = "1";
    try {
      expect(await revengServerFirst([], undefined, {})).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.UNBROWSE_LOCAL_ONLY;
      else process.env.UNBROWSE_LOCAL_ONLY = previous;
    }
  });
});

describe("embeddedJsonBlocks — JSON-shaped script assignments (not only type=json)", () => {
  it("recovers var data = [{…}] the way quotes.toscrape.com/js/ ships it", () => {
    const html = `<!doctype html><html><body>
      <h1>Quotes</h1>
      <script src="/static/jquery.js"></script>
      <script>
        var data = [
          {"tags":["a"],"author":{"name":"Albert Einstein"},"text":"one"},
          {"tags":["b"],"author":{"name":"J.K. Rowling"},"text":"two"},
          {"tags":["c"],"author":{"name":"Jane Austen"},"text":"three"}
        ];
      </script>
    </body></html>`;
    const blocks = embeddedJsonBlocks(html);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(blocks[0])).toBe(true);
    const col = findRecordCollection(blocks[0]);
    expect(col).not.toBeNull();
    expect(col!.count).toBe(3);
    expect(col!.fields).toContain("text");
  });

  it("still recovers type=application/json inert data blocks", () => {
    const html =
      `<script type="application/json" id="x">` +
      `{"items":[{"id":1,"name":"a"},{"id":2,"name":"b"}]}` +
      `</script>`;
    const blocks = embeddedJsonBlocks(html);
    expect(blocks.length).toBe(1);
    expect(findRecordCollection(blocks[0])?.count).toBe(2);
  });
});
