/**
 * Gates for the four ways `src/orchestrator/direct-document.ts` used to report
 * success while having failed. Every one of them had the same shape: the caller
 * could not tell a good result from a broken one.
 *
 *   1. Silent truncation. `bodyText.slice(0, MARKDOWN_BUDGET)` with no marker.
 *      Measured on data.gov.uk: at the 12k default the filter sidebar ate the
 *      whole allowance and 0 of 20 rows survived, with `rejected:false`, exit 0
 *      and no truncation signal anywhere in the JSON. 334 pages of that reads as
 *      "the site blocked me" rather than "we cut it".
 *   2. `--no-browser-cookies` / `UNBROWSE_IMPORT_BROWSER_COOKIES=0` failed OPEN —
 *      parsed, documented, and ignored by this file.
 *   3. A PDF came back as `result.text` beginning `%PDF-1.4` with
 *      `rejected:false, success:true`.
 *   4. The task/intent string was accepted and discarded: two unrelated tasks on
 *      one URL produced byte-identical output.
 *
 * Test discipline, because a green here has to mean something:
 *
 *   - OFFLINE AND DETERMINISTIC. No live site. The only network is a loopback
 *     fixture on an ephemeral port.
 *   - NO `spawnSync` ANYWHERE. `spawnSync` blocks the event loop, so an
 *     in-process `Bun.serve` never answers and every probe aborts — a silent
 *     fake green. Every child here is `Bun.spawn` + `await`.
 *   - NO `mock.module`. It is process-wide in bun and has broken unrelated
 *     suites in this repo.
 *   - VACUITY GUARDS. "No truncation marker" passes trivially on an empty
 *     response, and "no cookie sent" passes trivially when nothing was
 *     requested. Every negative assertion here is preceded by a positive one
 *     that proves the negative had a chance to fail.
 *   - No real credential is read or written: HOME is a throwaway directory and
 *     the only cookie in play is the synthetic literal below.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDirectDocumentResult,
  DEFAULT_MARKDOWN_BUDGET,
  detectBinaryBody,
  nonTextRatio,
  type DirectDocumentResult,
} from "../src/orchestrator/direct-document.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Never a real cookie value — a literal that exists only in this file. */
const SYNTHETIC_COOKIE_NAME = "unbrowse_fixture_session";
const SYNTHETIC_COOKIE_VALUE = "SYNTHETIC-NOT-A-REAL-SESSION-0001";

function accept(result: DirectDocumentResult | { rejected: true; reason: string }): DirectDocumentResult {
  if (result.rejected) throw new Error(`expected an accepted document, got rejection: ${result.reason}`);
  return result;
}

// ---------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------

/**
 * A data.gov.uk-shaped page: a large filter sidebar followed by the rows the
 * caller actually asked for. This is the exact geometry that made truncation
 * indistinguishable from an empty site — the sidebar is rendered first, so a
 * head-cut budget spends itself entirely on chrome and drops every row.
 */
const ROW_COUNT = 20;
function rowMarker(i: number): string {
  return `DATASETROW${String(i).padStart(2, "0")}`;
}
function sidebarRowsPage(): string {
  const filters = Array.from(
    { length: 320 },
    (_, i) => `<li><a href="/search?filter=${i}">Publisher and topic filter option number ${i} for the dataset search</a></li>`,
  ).join("");
  const rows = Array.from(
    { length: ROW_COUNT },
    (_, i) =>
      `<p>${rowMarker(i + 1)} — Local authority spending record for the reporting period, published as a downloadable resource.</p>`,
  ).join("");
  return (
    `<!doctype html><html><head><title>Find open data</title></head><body>` +
    `<nav><ul>${filters}</ul></nav><main>${rows}</main></body></html>`
  );
}

/**
 * Two topically disjoint sections behind a long neutral preamble. The preamble
 * matters: without it a query-focused selection that happens to start at char 0
 * would be byte-identical to the head slice, and the strategy discriminator
 * (`markdown === fullMarkdown.slice(0, budget)`) could not tell them apart.
 */
function twoTopicPage(): string {
  const preamble = Array.from(
    { length: 140 },
    (_, i) => `<p>Section ${i}: the northern weather station recorded steady barometric readings through the season.</p>`,
  ).join("");
  const hours = Array.from(
    { length: 40 },
    (_, i) => `<p>Opening hours notice ${i}: the hall is open from nine until five on weekdays and closes at noon on Sunday.</p>`,
  ).join("");
  const menu = Array.from(
    { length: 40 },
    (_, i) => `<p>Menu item ${i}: roasted seasonal plate, price 12 pounds, served with bread. Every plate is made to order.</p>`,
  ).join("");
  return (
    `<!doctype html><html><head><title>The Old Hall</title></head><body>` +
    `<main>${preamble}${hours}${menu}</main></body></html>`
  );
}

/**
 * A page over the 5KB HTML floor whose markdown still fits inside the default
 * 12k budget — the "nothing was cut, so the intent had nothing to select from"
 * case that produced the byte-identical outputs.
 */
function smallPage(): string {
  const body = Array.from(
    { length: 70 },
    (_, i) => `<p>Menu item ${i}: the opening hours and the price are listed on this compact single page for visitors.</p>`,
  ).join("");
  return `<!doctype html><html><head><title>Compact</title></head><body><main>${body}</main></body></html>`;
}

/**
 * The bytes of a PDF, decoded the way `res.text()` / `Buffer.toString("utf8")`
 * decode them — every non-UTF-8 byte becomes U+FFFD. This is what the extractor
 * is actually handed, so the fixture has to be built the same way rather than
 * from a pretty ASCII string.
 */
function pdfBodyAsDecodedText(): string {
  const head = Buffer.from("%PDF-1.4\r%âãÏÓ\n", "latin1");
  // Deterministic pseudo-binary object-stream noise (fixed LCG, no Math.random).
  const noise = Buffer.alloc(96_000);
  let seed = 0x2545f491;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed >> 16) & 0xff;
  }
  return new TextDecoder("utf-8").decode(Buffer.concat([head, noise]));
}

/**
 * A GBK page whose server declared no charset, so it was decoded as UTF-8 and
 * every Chinese character became U+FFFD. Dense in non-text characters — but it
 * is a DOCUMENT, and refusing it would be a new false failure of exactly the
 * family this change exists to remove.
 */
function misdecodedLegacyEncodingPage(): string {
  // Raw GBK double-byte runs: 0xC4 0xE3 is a valid GBK character and an INVALID
  // UTF-8 sequence, so a UTF-8 decode turns the whole run into U+FFFD — exactly
  // what an undeclared-charset legacy page looks like by the time it reaches the
  // extractor. The markup around it stays ASCII, which is the point.
  const cjk = Buffer.alloc(4_000);
  for (let i = 0; i < cjk.length; i += 2) {
    cjk[i] = 0xc4;
    cjk[i + 1] = 0xe3;
  }
  const bytes = Buffer.concat([
    Buffer.from("<!doctype html><html><head><title>", "ascii"),
    cjk.subarray(0, 200),
    Buffer.from("</title></head><body><div><p>", "ascii"),
    cjk,
    Buffer.from("</p></div><p>readable ascii tail</p></body></html>", "ascii"),
  ]);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Binary with no magic we list — only the structural density signal can catch it. */
function unknownBinaryAsDecodedText(): string {
  const buf = Buffer.alloc(20_000);
  let seed = 0x13579bdf;
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Force the high range so the bytes are not valid UTF-8 continuations.
    buf[i] = 0x80 | ((seed >> 16) & 0x7f);
  }
  return new TextDecoder("utf-8").decode(buf);
}

// ---------------------------------------------------------------------------
// 1. Truncation is reported, and the report is branchable
// ---------------------------------------------------------------------------

describe("direct-document reports truncation instead of looking like an empty site", () => {
  const page = sidebarRowsPage();
  const originalBudget = process.env.UNBROWSE_MARKDOWN_BUDGET;

  function withBudget<T>(budget: string | undefined, fn: () => T): T {
    if (budget === undefined) delete process.env.UNBROWSE_MARKDOWN_BUDGET;
    else process.env.UNBROWSE_MARKDOWN_BUDGET = budget;
    try {
      return fn();
    } finally {
      if (originalBudget === undefined) delete process.env.UNBROWSE_MARKDOWN_BUDGET;
      else process.env.UNBROWSE_MARKDOWN_BUDGET = originalBudget;
    }
  }

function markersIn(text: string): number {
    let n = 0;
    for (let i = 1; i <= ROW_COUNT; i++) if (text.includes(rowMarker(i))) n++;
    return n;
  }

  test("VACUITY GUARD: at a large budget the extraction is real and complete", () => {
    const result = withBudget("200000", () =>
      accept(buildDirectDocumentResult("https://www.data.gov.uk/search", page, "text/html")),
    );
    // Positive first: there IS a substantial extraction, and every row survived.
    expect(result.markdown.length).toBeGreaterThan(10_000);
    expect(markersIn(result.markdown)).toBe(ROW_COUNT);
    expect(markersIn(result.text_excerpt)).toBe(ROW_COUNT);
    // Only now is "no truncation reported" a meaningful assertion.
    expect(result.truncated).toBe(false);
    expect(result.extraction.truncated).toBe(false);
    expect(result.extraction.strategy).toBe("none");
    expect(result.extraction.markdown_chars).toBe(result.extraction.markdown_chars_available);
    expect(result.extraction.notes.some((n) => n.startsWith("TRUNCATED"))).toBe(false);
  });

  test("the measured defect: at the default budget every row is cut AND the response says so", () => {
    const result = withBudget(undefined, () =>
      accept(buildDirectDocumentResult("https://www.data.gov.uk/search", page, "text/html")),
    );
    // The defect reproduced: the caller gets an apparently-fine document with
    // none of the data it asked for.
    expect(markersIn(result.markdown)).toBe(0);
    expect(markersIn(result.text_excerpt)).toBe(0);
    expect(result.rejected).toBe(false);

    // The fix: the loss is stated, with the pre-truncation size to retry against.
    expect(result.truncated).toBe(true);
    expect(result.extraction.truncated).toBe(true);
    expect(result.extraction.budget).toBe(DEFAULT_MARKDOWN_BUDGET);
    expect(result.extraction.markdown_chars_available).toBeGreaterThan(result.extraction.markdown_chars);
    expect(result.extraction.text_excerpt_chars_available).toBeGreaterThan(result.extraction.text_excerpt_chars);
    expect(result.extraction.strategy).toBe("head-slice");
    expect(result.extraction.notes.some((n) => n.startsWith("TRUNCATED"))).toBe(true);
  });

  test("a caller can branch on it from the serialized JSON alone, not just stderr", () => {
    const wire = withBudget(undefined, () =>
      JSON.stringify(accept(buildDirectDocumentResult("https://www.data.gov.uk/search", page, "text/html"))),
    );
    // The original complaint verbatim: no `truncat`/`partial`/`clipped` anywhere
    // in the JSON. There is now.
    expect(wire).toMatch(/truncat/i);
    const parsed = JSON.parse(wire) as DirectDocumentResult;
    expect(parsed.truncated).toBe(true);
    expect(parsed.extraction.markdown_chars_available).toBeGreaterThan(parsed.extraction.markdown_chars);
    // The number in the note is actionable: raising the budget to it recovers the rows.
    const recovered = withBudget(String(parsed.extraction.markdown_chars_available + 1_000), () =>
      accept(buildDirectDocumentResult("https://www.data.gov.uk/search", page, "text/html")),
    );
    expect(markersIn(recovered.markdown)).toBe(ROW_COUNT);
    expect(recovered.truncated).toBe(false);
  });

  test("the budget escape hatch is read per call, not frozen at module load", () => {
    // A long-lived MCP/SDK process could not otherwise reach the documented knob.
    const cut = withBudget(undefined, () =>
      accept(buildDirectDocumentResult("https://www.data.gov.uk/search", page, "text/html")),
    );
    const whole = withBudget("200000", () =>
      accept(buildDirectDocumentResult("https://www.data.gov.uk/search", page, "text/html")),
    );
    expect(cut.extraction.budget).toBe(DEFAULT_MARKDOWN_BUDGET);
    expect(whole.extraction.budget).toBe(200_000);
    expect(whole.markdown.length).toBeGreaterThan(cut.markdown.length);
  });
});

// ---------------------------------------------------------------------------
// 2. A non-text body is refused, not emitted as content
// ---------------------------------------------------------------------------

describe("direct-document refuses a binary body instead of returning it as text", () => {
  test("VACUITY GUARD: a text page of the same size and content-type is accepted", () => {
    // Proves the rejections below come from the body being binary, not from the
    // size floor, the content-type gate, or any other gate firing first.
    const result = buildDirectDocumentResult("https://example.com/menu", sidebarRowsPage(), "text/html");
    expect(result.rejected).toBe(false);
  });

  test("a PDF served as text/html is refused with binary_not_text, and its bytes never become content", () => {
    const body = pdfBodyAsDecodedText();
    expect(body.startsWith("%PDF-")).toBe(true);
    expect(body.length).toBeGreaterThan(5_000); // clears the size floor, so only the binary gate can reject

    const result = buildDirectDocumentResult("https://example.com/menu.pdf", body, "text/html; charset=utf-8");
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("binary_not_text");
    expect(result.evidence?.binary_signature).toBe("pdf");

    // The whole point: `%PDF-1.4` must not reach the caller as page content.
    expect(JSON.stringify(result)).not.toContain("%PDF");
  });

  test("the content-type is not trusted: callers that hardcode text/html are still covered", () => {
    // src/execution/index.ts:28 and src/orchestrator/index.ts:5110/6009 all pass
    // a literal "text/html" for bytes they fetched themselves, so the claimed
    // type carries no information and the body has to be checked directly.
    for (const ct of ["text/html", "text/html; charset=utf-8", "application/xhtml+xml"]) {
      const result = buildDirectDocumentResult("https://example.com/doc", pdfBodyAsDecodedText(), ct);
      expect(result.rejected).toBe(true);
      if (!result.rejected) throw new Error("expected rejection");
      expect(result.reason).toBe("binary_not_text");
    }
  });

  test("recognition is structural: a container with no listed magic is still refused", () => {
    // The standing rule is "no hard filter when a structural signal exists".
    // Nothing in BINARY_MAGIC matches this body; the non-text density does.
    const result = buildDirectDocumentResult("https://example.com/blob", unknownBinaryAsDecodedText(), "text/html");
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("binary_not_text");
    expect(result.evidence?.binary_signature).toBe("non_text_density");
    expect(result.evidence?.non_text_ratio ?? 0).toBeGreaterThan(0.1);
  });

  test("HONEST NEGATIVE: a mis-decoded legacy-encoding page is dense but NOT refused", () => {
    // The refusal must not become a new false failure. This page is mojibake —
    // it would trip a bare density threshold — but it carries real markup, so it
    // is a document and the ladder above gets to judge it on its own merits.
    const page = misdecodedLegacyEncodingPage();
    // Positive first: it really is dense enough to have tripped a bare threshold.
    expect(nonTextRatio(page)).toBeGreaterThan(0.1);
    expect(detectBinaryBody(page)).toBeNull();
    const result = buildDirectDocumentResult("https://example.cn/article", page, "text/html");
    if (result.rejected) expect(result.reason).not.toBe("binary_not_text");
  });

  test("real markup measures as text, so the density gate cannot swallow ordinary pages", () => {
    expect(nonTextRatio(sidebarRowsPage())).toBe(0);
    expect(nonTextRatio(twoTopicPage())).toBe(0);
    expect(detectBinaryBody(sidebarRowsPage())).toBeNull();
    // Accented text, emoji and tabs are text, not binary.
    const unicodePage = `<!doctype html><html><body><p>café — naïve — 🌍 — ${"\tindented ".repeat(500)}</p></body></html>`;
    expect(detectBinaryBody(unicodePage)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The task/intent string is either applied or declared unapplied
// ---------------------------------------------------------------------------

describe("direct-document states plainly whether the task shaped the extraction", () => {
  const MENU_TASK = "list every menu item with its price";
  const HOURS_TASK = "what are the opening hours";

  test("VACUITY GUARD: both intents produce a real, accepted extraction", () => {
    const a = accept(buildDirectDocumentResult("https://example.com/hall", smallPage(), "text/html", MENU_TASK));
    const b = accept(buildDirectDocumentResult("https://example.com/hall", smallPage(), "text/html", HOURS_TASK));
    expect(a.markdown.length).toBeGreaterThan(500);
    expect(b.markdown.length).toBeGreaterThan(500);
  });

  test("the measured defect: identical output for two unrelated tasks is now DECLARED unfiltered", () => {
    const a = accept(buildDirectDocumentResult("https://example.com/hall", smallPage(), "text/html", MENU_TASK));
    const b = accept(buildDirectDocumentResult("https://example.com/hall", smallPage(), "text/html", HOURS_TASK));
    // The observed behaviour is unchanged and still byte-identical...
    expect(a.markdown).toBe(b.markdown);
    // ...but the response no longer implies the task did anything.
    expect(a.intent_applied).toBe(false);
    expect(b.intent_applied).toBe(false);
    expect(a.extraction.intent_status).toBe("unfiltered:page_within_budget");
    expect(a.extraction.intent_received).toBe(MENU_TASK);
    expect(b.extraction.intent_received).toBe(HOURS_TASK);
    expect(a.extraction.notes.some((n) => n.startsWith("UNFILTERED"))).toBe(true);
    expect(JSON.stringify(a)).toMatch(/unfiltered/i);
  });

  test("no intent reaching the extractor is reported as such, not as a filtered result", () => {
    // This is the state of every in-repo caller of fetchDirectDocument today.
    const r = accept(buildDirectDocumentResult("https://example.com/hall", smallPage(), "text/html"));
    expect(r.intent_applied).toBe(false);
    expect(r.extraction.intent_status).toBe("unfiltered:no_intent_supplied");
    expect(r.extraction.intent_received).toBeNull();
    expect(r.truth).toMatchObject({ truth_mode: "static_unevaluated", javascript_required: false, stealth_guaranteed: false });
    expect(r.pointer).toMatchObject({ url: "https://example.com/hall", url_template: "https://example.com/hall" });
    expect(r.pointer.complete_document_chars).toBeGreaterThanOrEqual(r.markdown.length);
  });

  test("static HTML cannot satisfy a JavaScript fingerprint intent", () => {
    const result = buildDirectDocumentResult(
      "https://example.com/fingerprint",
      sidebarRowsPage(),
      "text/html",
      "inspect Sannysoft webdriver and canvas fingerprint results after JavaScript",
    );
    expect(result).toMatchObject({ rejected: true, reason: "javascript_evaluation_required" });
  });

  test("intent_applied:true is not a lie — when it is true the two tasks return different text", () => {
    const page = twoTopicPage();
    const menu = accept(buildDirectDocumentResult("https://example.com/hall", page, "text/html", MENU_TASK));
    const hours = accept(buildDirectDocumentResult("https://example.com/hall", page, "text/html", HOURS_TASK));

    expect(menu.intent_applied).toBe(true);
    expect(hours.intent_applied).toBe(true);
    expect(menu.extraction.intent_status).toBe("applied:query-focused");
    expect(menu.extraction.strategy).toBe("query-focus");

    // The claim is falsifiable and here it holds: different task, different text.
    expect(menu.markdown).not.toBe(hours.markdown);
    expect(menu.markdown).toContain("Menu item");
    expect(hours.markdown).toContain("Opening hours notice");
  });

  test("query focus turned off is declared, not silently head-sliced as if filtered", () => {
    const prev = process.env.UNBROWSE_QUERY_FOCUS;
    process.env.UNBROWSE_QUERY_FOCUS = "0";
    try {
      const r = accept(buildDirectDocumentResult("https://example.com/hall", twoTopicPage(), "text/html", MENU_TASK));
      expect(r.intent_applied).toBe(false);
      expect(r.extraction.intent_status).toBe("unfiltered:query_focus_disabled");
      expect(r.extraction.strategy).toBe("head-slice");
    } finally {
      if (prev === undefined) delete process.env.UNBROWSE_QUERY_FOCUS;
      else process.env.UNBROWSE_QUERY_FOCUS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The browser-cookie opt-out fails CLOSED
// ---------------------------------------------------------------------------
//
// End-to-end against a loopback origin that records what it actually received,
// because the defect was a missing guard on a real code path — a unit assertion
// about a helper would not have caught it. The child processes are the only way
// to move the browser-profile readers off the real machine: bun resolves
// `os.homedir()` once per process, so HOME has to be set at SPAWN time.

interface Observed {
  tag: string;
  cookie: string | null;
}

describe("foreground task truth", () => {
  test("rejects a JavaScript verification interstitial despite HTTP-shaped HTML", () => {
    const html = `<!doctype html><html><head><title>Reddit - Please wait for verification</title></head><body>${"loading ".repeat(900)}<form><input name="js_challenge" value="1"></form></body></html>`;
    expect(buildDirectDocumentResult(
      "https://www.reddit.com/r/webscraping/",
      html,
      "text/html",
      "return a list of recent posts",
    )).toMatchObject({ rejected: true, reason: "interstitial_detected" });
  });

  test("does not promote a raw document to a list result", () => {
    const result = buildDirectDocumentResult(
      "https://shop.example/search?q=shoes",
      `<!doctype html><html><head><title>Shoes</title></head><body>${"Pegasus running shoes are available. ".repeat(250)}</body></html>`,
      "text/html",
      "return a product list of Pegasus shoes",
    );
    expect(result).toMatchObject({
      rejected: false,
      task_ok: false,
      intent_fulfilled: false,
      error: "response_shape_mismatch",
    });
  });
});

describe("direct-document honours the browser-cookie opt-out", () => {
  let home = "";
  let driver = "";
  let server: ReturnType<typeof Bun.serve> | null = null;
  let origin = "";
  const observed: Observed[] = [];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "unbrowse-dd-cookie-"));

    // A synthetic Firefox profile. Firefox is the plaintext-SQLite path
    // extractBrowserCookies tries first, so no keychain and no decryption is
    // involved and the fixture stays hermetic.
    const profile = join(home, ".mozilla", "firefox", "aaaaaaaa.default-release");
    mkdirSync(profile, { recursive: true });
    const db = new Database(join(profile, "cookies.sqlite"), { create: true });
    db.run(
      "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, " +
        "isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, expiry INTEGER)",
    );
    db.run(
      "INSERT INTO moz_cookies (name, value, host, path, isSecure, isHttpOnly, sameSite, expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [SYNTHETIC_COOKIE_NAME, SYNTHETIC_COOKIE_VALUE, "127.0.0.1", "/", 0, 1, 1, 4_102_444_800],
    );
    db.close();

    driver = join(home, "drive-direct-document.ts");
    writeFileSync(
      driver,
      `import { fetchDirectDocument } from ${JSON.stringify(join(REPO_ROOT, "src/orchestrator/direct-document.ts"))};\n` +
        `const doc = await fetchDirectDocument(process.argv[2]);\n` +
        `console.log(JSON.stringify({ fetched: doc !== null, title: doc?.title ?? null }));\n`,
    );

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        observed.push({ tag: url.searchParams.get("run") ?? "untagged", cookie: req.headers.get("cookie") });
        const body = Array.from(
          { length: 120 },
          (_, i) => `<p>Fixture paragraph ${i}: this loopback origin serves a plain document for the cookie gate.</p>`,
        ).join("");
        return new Response(
          `<!doctype html><html><head><title>Cookie fixture</title></head><body><main>${body}</main></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  /** Child env. HOME must be set at spawn; the opt-out var is set or DELETED explicitly. */
  function childEnv(optOut: string | null): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
    // The repo convention: never let a probe trigger the self-update path.
    env.UNBROWSE_UPDATE_COMMAND = "exit 1";
    env.UNBROWSE_NON_INTERACTIVE = "1";
    delete env.UNBROWSE_URL;
    if (optOut === null) delete env.UNBROWSE_IMPORT_BROWSER_COOKIES;
    else env.UNBROWSE_IMPORT_BROWSER_COOKIES = optOut;
    return env;
  }

  /** `Bun.spawn`, never `spawnSync`: the fixture origin lives on this event loop. */
  async function drive(tag: string, optOut: string | null): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(["bun", driver, `${origin}/page?run=${tag}`], {
      cwd: REPO_ROOT,
      env: childEnv(optOut),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(9), 60_000);
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { code, stdout };
    } finally {
      clearTimeout(timer);
    }
  }

  function seen(tag: string): Observed[] {
    return observed.filter((o) => o.tag === tag);
  }

  test("sqlite3 is present, so an absent tool cannot fake a green", () => {
    expect(existsSync("/usr/bin/sqlite3") || existsSync("/bin/sqlite3") || existsSync("/usr/local/bin/sqlite3")).toBe(true);
  });

  test(
    "VACUITY GUARD: with no opt-out the fixture DOES receive the synthetic cookie",
    async () => {
      const { code, stdout } = await drive("guard-off", null);
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim()).fetched).toBe(true);

      const reqs = seen("guard-off");
      expect(reqs.length).toBeGreaterThan(0);
      // The positive that makes the negative below meaningful: this exact
      // fixture, this exact host, DOES attach the browser session by default.
      expect(reqs.some((r) => (r.cookie ?? "").includes(SYNTHETIC_COOKIE_NAME))).toBe(true);
      expect(reqs.some((r) => (r.cookie ?? "").includes(SYNTHETIC_COOKIE_VALUE))).toBe(true);
    },
    120_000,
  );

  test(
    "UNBROWSE_IMPORT_BROWSER_COOKIES=0 sends NO cookie at all",
    async () => {
      const { code, stdout } = await drive("opt-out-0", "0");
      expect(code).toBe(0);
      // Not vacuous: the page was still fetched, the request still reached the origin.
      expect(JSON.parse(stdout.trim()).fetched).toBe(true);
      const reqs = seen("opt-out-0");
      expect(reqs.length).toBeGreaterThan(0);
      for (const r of reqs) {
        expect(r.cookie ?? "").not.toContain(SYNTHETIC_COOKIE_NAME);
        expect(r.cookie ?? "").not.toContain(SYNTHETIC_COOKIE_VALUE);
      }
    },
    120_000,
  );

  test(
    "the other documented falsey spellings are honoured too",
    async () => {
      for (const spelling of ["false", "off"]) {
        const tag = `opt-out-${spelling}`;
        const { code } = await drive(tag, spelling);
        expect(code).toBe(0);
        const reqs = seen(tag);
        expect(reqs.length).toBeGreaterThan(0);
        for (const r of reqs) expect(r.cookie ?? "").not.toContain(SYNTHETIC_COOKIE_NAME);
      }
    },
    180_000,
  );
});
