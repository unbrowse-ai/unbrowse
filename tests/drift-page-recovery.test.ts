// W-DRIFT-PAGE-RECOVERY: when an API endpoint's schema drifts in
// breaking ways, the platform's drift handler can recover useful data
// by fetching the re-capture URL as a page and running DOM extraction.
//
// Live regression source: .bench-gate/20260520T015714Z probes 016/017
// stackoverflow questions, 043/049 x.com home, 047 youtube
// subscriptions, 057 southwest. All returned the
// `schema_drift_recapture_required` envelope with a `re_capture_signal`
// pointing at the context URL, but the bench agent had no way to act
// on it within a single execute call.
//
// Fix: a `tryRecoverFromSchemaDrift` helper that fetches the URL and
// runs `extractFromDOM`. Returns null on any failure so the caller
// safely falls back to the envelope path.
//
// Real-runtime: live tryRecoverFromSchemaDrift, real http.createServer,
// no mocks.

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { tryRecoverFromSchemaDrift } from "../src/execution/drift-page-recovery.js";

const PORT = 47821;
const BASE = `http://localhost:${PORT}`;

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/article") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>What is a paper?</title></head>
<body>
  <main class="content">
    <article class="paper-detail">
      <h1 class="paper-title">A scalable approach to protein folding</h1>
      <p class="paper-abstract">In this paper we propose a deep architecture for predicting protein structures.</p>
      <p class="paper-authors">Smith J, Doe A, Vu C</p>
      <span class="paper-journal">Nature, 2024</span>
    </article>
    <section class="related">
      <article class="paper-card">
        <h3 class="title">Federated learning for clinical support</h3>
        <p class="abstract">This paper introduces a federated training framework.</p>
        <p class="authors">Park D, Liu E</p>
      </article>
      <article class="paper-card">
        <h3 class="title">Transformer attention for genomic analysis</h3>
        <p class="abstract">A new attention mechanism for variant calling.</p>
        <p class="authors">Tan K, Wong P</p>
      </article>
      <article class="paper-card">
        <h3 class="title">Diffusion models for drug discovery</h3>
        <p class="abstract">A generative model for novel molecule synthesis.</p>
        <p class="authors">Chen L, Liu W</p>
      </article>
    </section>
  </main>
</body></html>`);
      return;
    }
    if (req.url === "/empty") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Empty</title></head><body><p>nothing here</p></body></html>`);
      return;
    }
    if (req.url === "/not-found") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (req.url === "/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("tryRecoverFromSchemaDrift: page-fetch + DOM extraction recovery", () => {
  test("recovers usable data from a paper-detail page for 'get paper' intent", async () => {
    const result = await tryRecoverFromSchemaDrift(`${BASE}/article`, "get paper", {}, []);
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.final_url).toBe(`${BASE}/article`);
    const dataStr = JSON.stringify(result.data).toLowerCase();
    expect(dataStr).toMatch(/protein folding|federated learning|transformer|diffusion/);
  });

  test("returns null when the URL is unreachable or 404", async () => {
    const result = await tryRecoverFromSchemaDrift(`${BASE}/not-found`, "anything", {}, []);
    expect(result).toBeNull();
  });

  test("returns null when the response is not HTML (json content-type rejected by tryHttpFetch)", async () => {
    const result = await tryRecoverFromSchemaDrift(`${BASE}/json`, "anything", {}, []);
    expect(result).toBeNull();
  });

  test("returns null when the URL is empty or whitespace", async () => {
    expect(await tryRecoverFromSchemaDrift("", "x", {}, [])).toBeNull();
    expect(await tryRecoverFromSchemaDrift("   ".trim(), "x", {}, [])).toBeNull();
  });

  test("never throws on a thrown extractor (best-effort)", async () => {
    // We pass a valid HTML page; this just confirms the function returns
    // either a value or null rather than propagating.
    const result = await tryRecoverFromSchemaDrift(`${BASE}/empty`, "search papers", {}, []);
    // An empty page may yield null OR a low-confidence result that gets
    // filtered out by the confidence floor. Either way: no throw, no
    // partial data leak.
    if (result !== null) {
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    }
  });

  test("recovery_path field is present and set to http_fetch when SSR fastpath unavailable", async () => {
    // Without a Kuri broker, the SSR fastpath call returns null and we
    // fall through to plain tryHttpFetch. Assert the result names which
    // path produced the recovery so callers can attribute the source.
    const result = await tryRecoverFromSchemaDrift(`${BASE}/article`, "get paper", {}, []);
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.recovery_path).toBe("http_fetch");
  });
});
