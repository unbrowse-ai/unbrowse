/**
 * Is a learned internal API actually DOCUMENTED? (src/capture/skill-doc.ts)
 *
 * The bar this suite exists to enforce was measured, not imagined. The largest
 * skill on this machine — 225 KB, 55 endpoints — documents itself like this:
 *
 *     name        : "127.0.0.1"
 *     description : "DOM skill for 127.0.0.1"
 *     endpoint    : GET /search?q={q}
 *       description : "Page content from 127.0.0.1"   ← IDENTICAL on all 55
 *       semantic    : { description_in: "Requires q" }
 *       query       : none · constraints: 0
 *
 * An agent reading that cannot learn what `q` accepts, what comes back, whether
 * auth is needed, or how to page. So `expect(description.length > 0)` is exactly
 * the assertion that must NOT be written here: it passes on "Page content from
 * 127.0.0.1", which is the defect.
 *
 * Instead the gate is `documentationDefects()` below — a substance checker that is
 * run BOTH WAYS in this file:
 *   - against every endpoint the generator produces (must be defect-free), and
 *   - against a reconstruction of the real 55-endpoint baseline (must report
 *     defects). The second direction is what makes the first meaningful: a checker
 *     that cannot fail is not a gate.
 *
 * Everything is offline and deterministic. It reads tests/fixtures/captured-traffic.json
 * (2 captures, 27 requests, real shapes from data.europa.eu and careers.un.org, 5
 * PLANTED credentials) and writes only into an injected temp dir. It never touches
 * the developer's real ~/.unbrowse — a hazard that already truncated a live
 * route-cache in this codebase's history.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentEndpoint,
  describeSkill,
  documentSkillManifest,
  isDocumented,
} from "../src/capture/skill-doc.js";
import { revengLocal } from "../src/capture/reveng-local.js";
import { sanitizeForPublish } from "../src/publish/sanitize.js";
import type { RawRequest } from "../src/capture/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

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

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "captured-traffic.json");
const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
const [europa, un] = fixture.captures;
const PLANTED = Object.values(fixture.planted_credentials);

const infer = (capture: Capture): EndpointDescriptor[] =>
  revengLocal(capture.requests, { pageUrl: capture.page_url, finalUrl: capture.final_url });

const europaEndpoints = infer(europa);
const unEndpoints = infer(un);
const allEndpoints = [...europaEndpoints, ...unEndpoints];

const search = europaEndpoints.find((e) => e.url_template.includes("/api/hub/search/search"))!;
const facets = europaEndpoints.find((e) => e.url_template.includes("/api/hub/search/facets"))!;
const jobs = unEndpoints.find((e) => e.url_template.includes("/api/public/opening/jo-filter/"))!;

// ---------------------------------------------------------------------------
// The gate. Every check is a statement about SUBSTANCE, not about length.
// ---------------------------------------------------------------------------

/**
 * Everything wrong with one endpoint's documentation, as a list of reasons.
 * Empty ⇒ documented. Non-empty ⇒ a reader is missing something they need.
 *
 * The five questions a caller has, one check each:
 *   what does this return · what do I pass · what is required · do I need auth ·
 *   what does a correct call look like.
 */
function documentationDefects(endpoint: EndpointDescriptor): string[] {
  const defects: string[] = [];
  const doc = endpoint.description ?? "";

  // --- it must be about THIS endpoint, not a per-domain boilerplate string ---
  if (!doc.includes(endpoint.url_template)) defects.push("does not name its own url_template");
  if (!doc.includes(endpoint.method)) defects.push("does not name its own HTTP method");

  // --- what do I pass: every parameter of the route must be documented BY NAME,
  //     and each must say whether it is required ---
  const holes = [...endpoint.url_template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const bindings = endpoint.semantic?.requires ?? [];
  for (const hole of holes) {
    if (!bindings.some((b) => b.key === hole)) defects.push(`parameter ${hole} has no binding`);
    if (!doc.includes(`\`${hole}\``)) defects.push(`parameter ${hole} is not named in the prose`);
  }
  for (const binding of bindings) {
    const text = binding.description ?? "";
    if (!text.includes(binding.key)) defects.push(`binding ${binding.key} does not name itself`);
    if (!/REQUIRED|optional/.test(text)) {
      defects.push(`binding ${binding.key} does not say whether it is required`);
    }
    if (binding.required === undefined) defects.push(`binding ${binding.key} has no required flag`);
  }
  // The doc must agree with itself about how many parameters there are.
  const declared = doc.match(/^PARAMETERS \((\d+)\)$/m);
  if (!declared) defects.push("no PARAMETERS block");
  else if (Number(declared[1]) !== bindings.length) {
    defects.push(`PARAMETERS says ${declared[1]} but there are ${bindings.length} bindings`);
  }

  // --- what does this return: the record count and at least one REAL field name ---
  const fields = endpoint.semantic?.example_fields ?? [];
  if (fields.length === 0) defects.push("no response fields recorded");
  else if (!fields.some((f) => doc.includes(f))) defects.push("no real response field named in the prose");
  if (!/RETURNS/.test(doc)) defects.push("no RETURNS section");
  const collectionSize = endpoint.response_schema ? true : false;
  if (collectionSize && !/an array of \d+ like-shaped objects|\(\d+ sampled\)/.test(doc)) {
    defects.push("RETURNS does not state how many records came back");
  }

  // --- do I need auth: an explicit statement either way ---
  if (!/^AUTH$/m.test(doc)) defects.push("no AUTH section");
  if (!/(REQUIRED\. The captured call carried a session credential|Not required\. The captured call carried no credential)/.test(doc)) {
    defects.push("AUTH does not state whether a credential is needed");
  }

  // --- what does a correct call look like: a usable example ---
  const curl = doc.split("\n").find((line) => line.startsWith("curl "));
  if (!curl) defects.push("no example call");
  else {
    const quoted = [...curl.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const urlArg = quoted.find((q) => q.startsWith("http"));
    if (!urlArg) defects.push("example call has no URL");
    else {
      try {
        new URL(urlArg);
      } catch {
        defects.push("example call URL does not parse");
      }
      if (/\{[^}]+\}/.test(urlArg)) defects.push("example call URL still contains an unsubstituted {hole}");
    }
    if (endpoint.method !== "GET" && !curl.includes(`-X ${endpoint.method}`)) {
      defects.push("example call does not use the endpoint's method");
    }
  }

  // --- the in/out summaries must not be the graph-core stub ---
  const din = endpoint.semantic?.description_in ?? "";
  if (/^Requires [\w, ]+$/.test(din) || din === "No additional inputs required") {
    defects.push("description_in is the bare graph-core stub");
  }
  if (din.length === 0) defects.push("no description_in");
  const dout = endpoint.semantic?.description_out ?? "";
  if (dout.length === 0) defects.push("no description_out");
  else if (fields.length > 0 && !fields.some((f) => dout.includes(f))) {
    defects.push("description_out names no real field");
  }

  return defects;
}

/**
 * The measured baseline, reconstructed. This is what the 225 KB / 55-endpoint skill
 * on this machine actually carries per endpoint. It exists so the gate above can be
 * shown to REJECT it — otherwise "documented" would be an unfalsifiable claim.
 */
function baselineEndpoint(): EndpointDescriptor {
  return {
    endpoint_id: "baseline0000000000000",
    method: "GET",
    url_template: "http://127.0.0.1/search?q={q}",
    description: "Page content from 127.0.0.1",
    idempotency: "safe",
    verification_status: "unverified",
    reliability_score: 0.5,
    semantic: {
      action_kind: "search",
      resource_kind: "resource",
      description_in: "Requires q",
    },
  };
}

// ---------------------------------------------------------------------------

describe("the gate itself can fail — the measured baseline is REJECTED", () => {
  const defects = documentationDefects(baselineEndpoint());

  it("rejects the real 55-endpoint baseline description", () => {
    expect(defects.length).toBeGreaterThan(0);
  });

  it("names the specific things a reader is missing, not just 'bad'", () => {
    const joined = defects.join(" | ");
    expect(joined).toContain("parameter q is not named in the prose");
    expect(joined).toContain("description_in is the bare graph-core stub");
    expect(joined).toContain("no AUTH section");
    expect(joined).toContain("no example call");
    expect(joined).toContain("no RETURNS section");
  });

  it("a length check — the assertion this suite refuses to make — would have PASSED it", () => {
    // Pinning the anti-pattern so nobody 'simplifies' the gate back into one.
    expect((baselineEndpoint().description ?? "").length).toBeGreaterThan(0);
  });

  it("rejects a constant description even when it is long and grammatical", () => {
    const constant = { ...baselineEndpoint(), description: "This endpoint returns page content from the 127.0.0.1 site, which may be useful for a variety of retrieval tasks depending on what the caller needs." };
    expect(documentationDefects(constant).length).toBeGreaterThan(0);
  });
});

describe("every learned endpoint is documented", () => {
  it("no endpoint has any documentation defect", () => {
    const failures = allEndpoints
      .map((e) => ({ url: e.url_template, defects: documentationDefects(e) }))
      .filter((entry) => entry.defects.length > 0);
    expect(failures).toEqual([]);
  });

  it("the 7 endpoints do NOT share one description — the baseline's actual failure", () => {
    const distinct = new Set(allEndpoints.map((e) => e.description));
    expect(allEndpoints.length).toBeGreaterThan(1);
    expect(distinct.size).toBe(allEndpoints.length);
  });

  it("a parameter's documentation names it and says whether it is required", () => {
    const page = search.semantic!.requires!.find((b) => b.key === "page")!;
    expect(page.description).toContain("page");
    expect(page.description).toContain("optional");
    // …and the paging FACT, recognised from observed integer variation, not the name.
    expect(page.description).toMatch(/Pages through the collection/);

    const token = facets.semantic!.requires!.find((b) => b.key === "session_token")!;
    expect(token.required).toBe(true);
    expect(token.description).toContain("REQUIRED");
    expect(token.description).toContain("supply your own");
  });

  it("paging is recognised from observed integer variation, on a route whose pager is not called 'page'", () => {
    // `limit` on the UN route is NOT documented as a pager (one observed value) but IS
    // documented as bounding the page size — because 25 observed == 25 records returned.
    const limit = jobs.semantic!.requires!.find((b) => b.key === "limit")!;
    expect(limit.description).toContain("Bounds how many records come back");
    expect(limit.description).toContain("25");
    // No allowlist made that call: the same generator says something different about
    // `limit` on the europa route, where 20 observed != 80 records returned.
    const europaLimit = search.semantic!.requires!.find((b) => b.key === "limit")!;
    expect(europaLimit.description).not.toContain("Bounds how many records come back");
  });

  it("a param the site itself sent EMPTY is documented as optional, not as a hole to fill", () => {
    for (const key of ["jn", "jf", "jl"]) {
      const binding = jobs.semantic!.requires!.find((b) => b.key === key)!;
      expect(binding.required).toBe(false);
      expect(binding.description).toContain("EMPTY");
      expect(binding.description).toContain("no filter");
    }
  });

  it("the response description states the record count, where it lives, and real field names", () => {
    const doc = search.description!;
    expect(doc).toContain("an array of 80 like-shaped objects");
    expect(doc).toContain("`result.results`");
    expect(doc).toContain("access_url (string)");
    expect(doc).toContain("media_type (string)");
    // and the machine-readable twin agrees
    expect(search.semantic!.description_out).toContain("80");
    expect(search.semantic!.description_out).toContain("result.results");
    expect(search.semantic!.description_out).toContain("access_url");
  });

  it("auth is stated explicitly in BOTH directions across the endpoint set", () => {
    const authed = allEndpoints.filter((e) => e.semantic?.auth_required);
    const open = allEndpoints.filter((e) => !e.semantic?.auth_required);
    expect(authed.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
    for (const e of authed) expect(e.description).toContain("Send YOUR OWN cookie");
    for (const e of open) expect(e.description).toContain("Not required.");
  });

  it("the example call is syntactically usable: it parses, it is filled in, it round-trips", () => {
    const curl = search.description!.split("\n").find((l) => l.startsWith("curl "))!;
    const url = [...curl.matchAll(/'([^']*)'/g)].map((m) => m[1]).find((q) => q.startsWith("http"))!;
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("data.europa.eu");
    expect(parsed.pathname).toBe("/api/hub/search/search");
    // Every hole is substituted with the value the route actually replays by default.
    expect(parsed.searchParams.get("q")).toBe(String(search.query!.q));
    expect(parsed.searchParams.get("page")).toBe(String(search.query!.page));
    expect(url).not.toContain("{");
    // The structured twin is the same call.
    const request = search.semantic!.example_request as { method: string; url: string; headers: Record<string, string> };
    expect(request.method).toBe("GET");
    expect(request.url).toBe(url);
    expect(request.headers.cookie).toContain("your data.europa.eu session cookie");
  });

  it("required parameters also land as machine-readable constraints", () => {
    const constraint = facets.constraints!.find((c) => c.param === "session_token")!;
    expect(constraint.rule).toBe("required");
    // Deterministic provenance: the capture's own timestamp, never a clock read.
    expect(constraint.learned_at).toBe(facets.semantic!.observed_at!);
    // …and a route with no required params gets none, rather than a fabricated row.
    expect(search.constraints ?? []).toEqual([]);
  });

  it("an SSR route says its payload rides inside HTML, so a JSON-only reader is not misled", () => {
    const ssr = unEndpoints.find((e) => e.dom_extraction?.extraction_method === "spa-embedded-json")!;
    expect(ssr.description).toContain("inert JSON data-block inside the HTML page");
    expect(ssr.description).toContain("HTML carrying an embedded JSON block");
  });
});

describe("no credential enters the documentation", () => {
  it("none of the 5 planted credentials appears anywhere in any generated doc", () => {
    const documentation = allEndpoints
      .map((e) => [e.description, JSON.stringify(e.semantic), JSON.stringify(e.constraints)].join("\n"))
      .join("\n");
    expect(documentation.length).toBeGreaterThan(1000);
    for (const secret of PLANTED) expect(documentation).not.toContain(secret);
  });

  it("the endpoints survive — this is absence of a leak, not absence of output", () => {
    // The fail-closed sweep DROPS a descriptor carrying a secret, so "no secret found"
    // would be trivially true on an empty list. It is not empty.
    expect(allEndpoints.length).toBe(7);
    for (const e of allEndpoints) expect((e.description ?? "").length).toBeGreaterThan(400);
  });

  it("a credential planted where the doc generator would quote it drops the route, never ships it", () => {
    // The cookie value is forced into a query parameter, i.e. straight into the place
    // the PARAMETERS block and the example call quote observed values from.
    const secret = fixture.planted_credentials.cookie;
    const poisoned: RawRequest[] = europa.requests.map((r) =>
      r.url.includes("/api/hub/search/search") && r.method === "GET"
        ? { ...r, url: `${r.url}&tracking=${secret}` }
        : r,
    );
    const out = revengLocal(poisoned, { pageUrl: europa.page_url });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("the auth statement names the MECHANISM and never a value", () => {
    expect(search.description).toContain("Send YOUR OWN cookie for data.europa.eu");
    expect(search.description).not.toMatch(/Cookie:\s*SESSIONID=/);
    // The example's auth is a shape, not a captured header.
    expect(search.description).toContain("<your data.europa.eu session cookie>");
  });

  it("the observed value lives in example_value — the field the publish boundary strips", () => {
    const q = search.semantic!.requires!.find((b) => b.key === "q")!;
    expect(q.example_value).toBe("climate");
    // Deliberately NOT in binding.description: sanitizeForPublish strips example_value
    // but does not scrub a binding's prose, so quoting a value there would route around
    // the boundary.
    expect(q.description).not.toContain("climate");
    const published = sanitizeForPublish([search])[0];
    const publishedQ = published.semantic!.requires!.find((b) => b.key === "q")!;
    expect(publishedQ.example_value).toBeUndefined();
    // The documentation itself still publishes.
    expect(publishedQ.description).toContain("`q`");
    expect(published.description).toContain("PARAMETERS");
    expect(published.description).toContain("AUTH");
  });
});

describe("determinism — no model, no clock, no randomness", () => {
  it("documenting the same capture twice is byte-identical, in-process", () => {
    expect(JSON.stringify(infer(europa))).toBe(JSON.stringify(europaEndpoints));
    expect(JSON.stringify(infer(un))).toBe(JSON.stringify(unEndpoints));
  });

  it("documentation is idempotent — re-documenting a documented endpoint changes nothing", () => {
    for (const e of allEndpoints) {
      expect(isDocumented(e)).toBe(true);
      expect(JSON.stringify(documentEndpoint(e))).toBe(JSON.stringify(e));
    }
  });

  it("re-documenting WITH fresh evidence does not double the parameter list", () => {
    // The regression this pins: graph-core's `mergeBindings` dedupes on
    // `bindingIdentity`, which includes `type` and `required` — both of which
    // documenting a binding SETS. So the second pass over an already-documented
    // endpoint used to merge each parameter with its own undocumented twin and report
    // "PARAMETERS (6) … q, limit, page, q, limit, page" for a 3-parameter route.
    // Passing evidence deliberately bypasses the "already documented" short-circuit,
    // so this exercises the (name, location) dedupe itself.
    const again = documentEndpoint(search, { observations: 3, record_count: 80 });
    const distinct = new Set(search.semantic!.requires!.map((b) => b.key));
    expect(distinct.size).toBe(3);
    expect(again.semantic!.requires!.length).toBe(distinct.size);
    expect(again.description).toContain(`PARAMETERS (${distinct.size})`);
    expect(again.semantic!.description_in).toContain("Takes 3 parameters");
    // No parameter is listed twice anywhere in the prose.
    for (const key of distinct) {
      const hits = again.description!.split("\n").filter((l) => l.trimStart().startsWith(`\`${key}\``));
      expect(hits.length).toBe(1);
    }
  });

  it("TWO SEPARATE OS PROCESSES produce the same sha256", () => {
    // The real reproducibility claim: a fresh interpreter, a fresh module graph, a
    // fresh clock. Anything model- or time-derived would diverge here.
    const script = join(tmpDir, "determinism.ts");
    writeFileSync(
      script,
      [
        `import { readFileSync } from "node:fs";`,
        `import { createHash } from "node:crypto";`,
        `import { revengLocal } from ${JSON.stringify(join(import.meta.dir, "..", "src", "capture", "reveng-local.ts"))};`,
        `const fx = JSON.parse(readFileSync(${JSON.stringify(FIXTURE_PATH)}, "utf-8"));`,
        `const out = fx.captures.map((c: any) => revengLocal(c.requests, { pageUrl: c.page_url, finalUrl: c.final_url }));`,
        `process.stdout.write(createHash("sha256").update(JSON.stringify(out)).digest("hex"));`,
      ].join("\n"),
      "utf-8",
    );
    const run = (): string => execFileSync("bun", ["run", script], { encoding: "utf-8" }).trim();
    const first = run();
    const second = run();
    expect(first).toBe(second);
    expect(first).toBe(
      createHash("sha256").update(JSON.stringify([europaEndpoints, unEndpoints])).digest("hex"),
    );
    // Two cold `bun run` starts; the 5s default is not enough when the suite is run
    // alongside others, and a timeout here reads as a determinism failure when it is not.
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Persistence. NEVER the developer's real ~/.unbrowse — a temp dir, injected.
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "unbrowse-skill-doc-"));
const snapshotDir = join(tmpDir, "skill-snapshots");
mkdirSync(snapshotDir, { recursive: true });

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function buildManifest(domain: string, endpoints: EndpointDescriptor[], pageUrl: string): SkillManifest {
  const header = describeSkill(domain, endpoints, { pageUrl });
  return {
    skill_id: `local-${domain}`,
    version: "1.0.0",
    schema_version: "1",
    name: header.name,
    intent_signature: domain,
    domain,
    description: header.description,
    owner_type: "agent",
    execution_type: "http",
    endpoints,
    lifecycle: "active",
    created_at: "2026-07-31T09:14:02.137Z",
    updated_at: "2026-07-31T09:14:02.137Z",
    intents: header.intents,
  } as SkillManifest;
}

describe("the skill header says something — 'DOM skill for 127.0.0.1' is the bar", () => {
  const header = describeSkill("data.europa.eu", europaEndpoints, { pageUrl: europa.page_url });

  it("the description states route count, what they return, the auth split and the trust level", () => {
    expect(header.description).toContain("3 routes");
    expect(header.description).toContain("2 of 3 routes need an authenticated session");
    expect(header.description).toContain("unverified");
    // real field names, so a reader knows what is in there without opening an endpoint
    expect(header.description).toContain("access_url");
    // and it is not the boilerplate
    expect(header.description).not.toMatch(/^DOM skill for/);
  });

  it("intents carry the resource tokens a retriever needs", () => {
    expect(header.intents.length).toBe(3);
    expect(header.intents.some((i) => i.includes("search") && i.includes("data.europa.eu"))).toBe(true);
  });

  it("an empty skill says so honestly rather than describing nothing", () => {
    expect(describeSkill("x.test", []).description).toContain("No internal API routes have been learned");
  });
});

describe("round-trip: the documentation survives being persisted and read back", () => {
  const manifest = documentSkillManifest(
    buildManifest("data.europa.eu", europaEndpoints, europa.page_url),
  );
  const digest = createHash("sha1").update(manifest.skill_id).digest("hex");
  const path = join(snapshotDir, `${digest}.json`);
  writeFileSync(path, JSON.stringify(manifest), "utf-8");

  const reread = JSON.parse(readFileSync(path, "utf-8")) as SkillManifest;

  it("writes and reads back byte-identically (JSON is lossless for this shape)", () => {
    expect(JSON.stringify(reread)).toBe(JSON.stringify(manifest));
  });

  it("the re-read manifest is still fully documented by the same gate", () => {
    for (const endpoint of reread.endpoints) {
      expect(documentationDefects(endpoint)).toEqual([]);
    }
  });

  it("the re-read endpoint still answers all five questions a caller has", () => {
    const rereadSearch = reread.endpoints.find((e) => e.url_template.includes("/search/search"))!;
    expect(rereadSearch.description).toContain("PARAMETERS (3)");
    expect(rereadSearch.description).toContain("an array of 80 like-shaped objects");
    expect(rereadSearch.description).toContain("Send YOUR OWN cookie");
    expect(rereadSearch.description).toContain("curl -sS");
    expect(rereadSearch.semantic?.requires?.length).toBe(3);
    expect(rereadSearch.semantic?.requires?.[0].description).toContain("`q`");
  });

  it("the header survived too, and no planted credential rode along", () => {
    expect(reread.name).toBe("data.europa.eu internal API");
    expect(reread.description).toContain("2 of 3 routes need an authenticated session");
    const blob = readFileSync(path, "utf-8");
    for (const secret of PLANTED) expect(blob).not.toContain(secret);
  });

  it("the snapshot was written to the injected temp dir, never to ~/.unbrowse", () => {
    expect(path.startsWith(tmpDir)).toBe(true);
    expect(path).not.toContain(".unbrowse");
  });
});
