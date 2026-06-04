import { describe, expect, test } from "bun:test";
import { applyFlashMode } from "../src/mcp.js";

// Child contract: add-a-flash-minimal-resolve-output-mode-to-unbro
// Best practice source_id: deepwiki:browser-use/browser-use (flash_mode
// minimal output format). flash trims every available_endpoints[] candidate
// to its dispatch keys (endpoint_id + skill_id) + a one-line flash_evidence
// string, cutting shortlist tokens. The full rich shortlist stays the default.

// A realistic rich candidate as the backend's /v1/intent/resolve emits it.
function richCandidate(id: string, score: number) {
  return {
    endpoint_id: id,
    skill_id: "skill-news-ycombinator",
    url: `https://news.ycombinator.com/item?id=${id}`,
    score,
    description: `Returns the comment thread and metadata for HN item ${id}.`,
    example_response_compact: { id, title: "x".repeat(400), kids: [1, 2, 3, 4, 5] },
    input_params: { id: { type: "string", required: true } },
    requires: ["id"],
    yields: ["title", "by", "kids", "text", "time"],
    sample_values: { title: "Some story", by: "pg", time: 1700000000 },
  };
}

function resolveResult() {
  return {
    available_endpoints: [richCandidate("a1", 0.92), richCandidate("b2", 0.71)],
    result: { status: "ok" },
  };
}

describe("applyFlashMode — token-minimal resolve shortlist", () => {
  test("flash=true reduces each candidate to endpoint_id + skill_id + flash_evidence only", () => {
    const out = applyFlashMode(resolveResult(), { flash: true });
    const list = out.available_endpoints as Array<Record<string, unknown>>;
    expect(Array.isArray(list), "available_endpoints stays an array").toBe(true);
    expect(list.length, "every candidate is kept, only trimmed").toBe(2);
    for (const c of list) {
      expect(Object.keys(c).sort(), "flash candidate has exactly the 3 minimal keys")
        .toEqual(["endpoint_id", "flash_evidence", "skill_id"]);
      // heavy fields must be gone — that is the whole point of flash
      expect(c.example_response_compact, "example_response_compact dropped").toBeUndefined();
      expect(c.sample_values, "sample_values dropped").toBeUndefined();
      expect(c.input_params, "input_params dropped").toBeUndefined();
      expect(c.yields, "yields schema dropped").toBeUndefined();
    }
  });

  test("flash candidate keeps both dispatch keys so unbrowse_execute is still callable", () => {
    const out = applyFlashMode(resolveResult(), { flash: true });
    const first = (out.available_endpoints as Array<Record<string, unknown>>)[0];
    expect(first.endpoint_id, "endpoint_id preserved").toBe("a1");
    expect(first.skill_id, "skill_id preserved").toBe("skill-news-ycombinator");
  });

  test("flash_evidence is one non-empty line carrying the description and score", () => {
    const out = applyFlashMode(resolveResult(), { flash: true });
    const ev = (out.available_endpoints as Array<Record<string, unknown>>)[0].flash_evidence as string;
    expect(typeof ev, "flash_evidence is a string").toBe("string");
    expect(ev.length, "flash_evidence is non-empty").toBeGreaterThan(0);
    expect(ev.includes("\n"), "flash_evidence is a single line").toBe(false);
    expect(ev.includes("HN item a1"), "flash_evidence carries the description").toBe(true);
    expect(ev.includes("score 0.92"), "flash_evidence carries the score").toBe(true);
  });

  test("flash result is token-smaller than the full shortlist", () => {
    const full = JSON.stringify(resolveResult().available_endpoints).length;
    const flash = JSON.stringify(
      (applyFlashMode(resolveResult(), { flash: true }).available_endpoints),
    ).length;
    expect(flash, `flash (${flash}) must be smaller than full (${full})`).toBeLessThan(full);
  });

  test("flash=true sets the flash_mode marker on the result", () => {
    const out = applyFlashMode(resolveResult(), { flash: true });
    expect(out.flash_mode, "flash_mode marker is set").toBe(true);
  });

  test("flash unset returns the full rich shortlist unchanged (default behaviour)", () => {
    const input = resolveResult();
    const out = applyFlashMode(input, {});
    expect(out, "no flash arg => identical object reference returned").toBe(input);
    const first = (out.available_endpoints as Array<Record<string, unknown>>)[0];
    expect(first.example_response_compact, "rich fields untouched without flash").toBeDefined();
  });

  test("flash=true with no available_endpoints array is a safe no-op", () => {
    const input = { result: { status: "no_cached_match" } };
    const out = applyFlashMode(input, { flash: true });
    expect(out, "missing shortlist => returned unchanged").toBe(input);
  });

  test("flash evidence is length-capped so a verbose description cannot blow the budget", () => {
    const fat = { available_endpoints: [{
      endpoint_id: "e", skill_id: "s", url: "https://x.test/y",
      score: 0.5, description: "z".repeat(900),
    }] };
    const out = applyFlashMode(fat, { flash: true });
    const ev = (out.available_endpoints as Array<Record<string, unknown>>)[0].flash_evidence as string;
    expect(ev.length, "flash_evidence capped at 200 chars").toBeLessThanOrEqual(200);
    expect(ev.endsWith("..."), "over-long evidence is elided").toBe(true);
  });
});

// Intent-only resolves with no marketplace endpoints land on the Exa /
// probe-fallback shape: { result: { data, exa_candidates: [...], ... } }.
// flash must trim the heavy per-candidate highlights here too — before this it
// was silently ignored on the most common path and returned the full rich shape.
function exaResolveResult() {
  return {
    source: "exa",
    result: {
      data: ["The live Bitcoin price today is $63,819.42 USD ..."],
      source_url: "https://coinmarketcap.com/currencies/bitcoin/",
      exa_answer: true,
      exa_candidates: [
        {
          url: "https://coinmarketcap.com/currencies/bitcoin/",
          title: "Bitcoin price today",
          score: 0,
          highlights_excerpt: "Bitcoin price today, BTC to USD live price ".repeat(20),
          next_step: { go: "unbrowse go ...", fetch: "unbrowse fetch ..." },
        },
        {
          url: "https://www.coingecko.com/en/coins/bitcoin",
          title: "Bitcoin Price: BTC/USD Live",
          score: 0,
          highlights_excerpt: "BTC $63,947.93 ".repeat(30),
        },
      ],
      suggested_commands: ["unbrowse fetch --url \"https://coinmarketcap.com/currencies/bitcoin/\""],
    },
  };
}

describe("applyFlashMode — Exa / probe-fallback shape", () => {
  test("flash=true trims each exa candidate to url + title + score + short flash_evidence", () => {
    const out = applyFlashMode(exaResolveResult(), { flash: true });
    expect(out.flash_mode, "flash_mode flag set").toBe(true);
    const inner = out.result as Record<string, unknown>;
    const cands = inner.exa_candidates as Array<Record<string, unknown>>;
    expect(cands.length, "every candidate kept, only trimmed").toBe(2);
    for (const c of cands) {
      expect(Object.keys(c).sort(), "exactly the 4 minimal keys")
        .toEqual(["flash_evidence", "score", "title", "url"]);
      expect(c.highlights_excerpt, "heavy highlights_excerpt dropped").toBeUndefined();
      expect(c.next_step, "per-candidate next_step dropped").toBeUndefined();
      expect((c.flash_evidence as string).length, "flash_evidence capped at 160").toBeLessThanOrEqual(160);
    }
  });

  test("flash keeps the answer and actionable next steps intact", () => {
    const out = applyFlashMode(exaResolveResult(), { flash: true });
    const inner = out.result as Record<string, unknown>;
    expect(Array.isArray(inner.data), "data answer preserved").toBe(true);
    expect(inner.source_url, "source_url preserved").toBe("https://coinmarketcap.com/currencies/bitcoin/");
    expect(Array.isArray(inner.suggested_commands), "suggested_commands preserved").toBe(true);
  });

  test("flash=false leaves the exa shape untouched", () => {
    const input = exaResolveResult();
    const out = applyFlashMode(input, { flash: false });
    expect(out, "no flash => unchanged reference").toBe(input);
  });
});

// Cold page-content resolves land on the direct-document shape:
// { result: { title, url, text_excerpt, markdown, tables, extraction } }.
// markdown is the heavy duplicate of text_excerpt — flash must drop it.
function directDocumentResolveResult() {
  return {
    source: "direct-document",
    result: {
      rejected: false,
      title: "Hacker News",
      url: "https://news.ycombinator.com",
      content_type: "text/html; charset=utf-8",
      html_bytes: 34514,
      text_excerpt: "Story one. Story two. Story three.",
      markdown: "[Story one](https://a) [Story two](https://b) ".repeat(400),
      tables: [],
      extraction: { source: "direct-document", rejected: false },
    },
  };
}

describe("applyFlashMode — direct-document shape", () => {
  test("flash=true drops the heavy markdown render, keeps the excerpt + dispatch keys", () => {
    const out = applyFlashMode(directDocumentResolveResult(), { flash: true });
    expect(out.flash_mode, "flash_mode flag set").toBe(true);
    const inner = out.result as Record<string, unknown>;
    expect(inner.markdown, "full markdown dropped").toBeUndefined();
    expect(inner.html_bytes, "html_bytes dropped").toBeUndefined();
    expect(inner.title, "title preserved").toBe("Hacker News");
    expect(inner.url, "url preserved").toBe("https://news.ycombinator.com");
    expect(inner.text_excerpt, "text_excerpt preserved").toBe("Story one. Story two. Story three.");
    expect((inner.extraction as Record<string, unknown>).source, "extraction tag preserved").toBe("direct-document");
  });

  test("flash caps an oversized text_excerpt so the response stays bounded", () => {
    const big = directDocumentResolveResult();
    (big.result as Record<string, unknown>).text_excerpt = "x".repeat(5000);
    const out = applyFlashMode(big, { flash: true });
    const inner = out.result as Record<string, unknown>;
    expect((inner.text_excerpt as string).length, "text_excerpt capped at 2000").toBeLessThanOrEqual(2000);
    expect((inner.text_excerpt as string).endsWith("..."), "over-long excerpt elided").toBe(true);
  });

  test("flash=false leaves the direct-document shape untouched", () => {
    const input = directDocumentResolveResult();
    const out = applyFlashMode(input, { flash: false });
    expect(out, "no flash => unchanged reference").toBe(input);
  });
});
