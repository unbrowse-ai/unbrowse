/**
 * Structural pin for the public /claim page.
 *
 * The page is a Next.js client component; testing it with full React SSR
 * would require react-dom/server wiring this repo does not have. Instead
 * we pin the SOURCE invariants the page must satisfy: three sections
 * with their h2 titles, required form fields per section, a well-formed
 * mailto fallback, no em dashes, no identical card grids, and no
 * dangerouslySetInnerHTML (so React's default escaping handles XSS).
 *
 * Plus a behavioural pin on the typed client: `buildOfficialSubmissionMailto`
 * is exercised with a real domain string so the mailto path is wired.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOfficialSubmissionMailto } from "../frontend/src/lib/claim-client";

const PAGE_PATH = join(
  import.meta.dir,
  "..",
  "frontend",
  "src",
  "app",
  "claim",
  "page.tsx",
);
const CLIENT_PATH = join(
  import.meta.dir,
  "..",
  "frontend",
  "src",
  "lib",
  "claim-client.ts",
);

const pageSource = readFileSync(PAGE_PATH, "utf-8");
const clientSource = readFileSync(CLIENT_PATH, "utf-8");

describe("/claim page structural shape", () => {
  it("declares a default-exported page component", () => {
    expect(pageSource).toContain("export default function ClaimPage");
  });

  it("renders the three required h2 section titles", () => {
    // Section 1 — claim wallet
    expect(pageSource).toMatch(/Claim your domain wallet/);
    // Section 2 — opt out
    expect(pageSource).toMatch(/Opt out of the marketplace/);
    // Section 3 — submit official API
    expect(pageSource).toMatch(/Submit your official API/);
  });

  it("each section is a distinct <section> element", () => {
    const sectionOpens = pageSource.match(/<section[\s>]/g) ?? [];
    // The three feature sections all start with <section, and the page may
    // contain additional <section> blocks for header / footer. Require at
    // least three.
    expect(sectionOpens.length).toBeGreaterThanOrEqual(3);
  });

  it("section 1 has a domain field and a wallet field", () => {
    // Domain input on the claim flow
    expect(pageSource).toMatch(/name="domain"/);
    // Wallet input on the claim flow
    expect(pageSource).toMatch(/name="wallet"/);
  });

  it("section 2 has a distinct domain field for the opt-out form", () => {
    expect(pageSource).toMatch(/name="optout-domain"/);
  });

  it("section 3 has the official-API submission form fields", () => {
    expect(pageSource).toMatch(/name="official-domain"/);
    expect(pageSource).toMatch(/name="contact-email"/);
    expect(pageSource).toMatch(/name="skill-name"/);
    expect(pageSource).toMatch(/name="skill-description"/);
    // Dynamic endpoint list — at least the method, url_template, description
    // and x402_supported field names must be present.
    expect(pageSource).toMatch(/endpoints\[\$\{idx\}\]\[method\]/);
    expect(pageSource).toMatch(/endpoints\[\$\{idx\}\]\[url_template\]/);
    expect(pageSource).toMatch(/endpoints\[\$\{idx\}\]\[description\]/);
    expect(pageSource).toMatch(/endpoints\[\$\{idx\}\]\[x402_supported\]/);
  });

  it("section 3 wires a mailto fallback link", () => {
    expect(pageSource).toMatch(/mailtoHref/);
    expect(pageSource).toMatch(/Or email the team instead/);
  });
});

describe("/claim mailto fallback", () => {
  it("buildOfficialSubmissionMailto produces a well-formed mailto: URL", () => {
    const href = buildOfficialSubmissionMailto("acme.test");
    expect(href.startsWith("mailto:hello@unbrowse.ai?")).toBe(true);
    // Subject is URL-encoded; the encoded form of "Official skill submission"
    // is "Official%20skill%20submission".
    expect(href).toContain("subject=Official%20skill%20submission%20for%20acme.test");
    // Body must be URL-encoded too; require either an encoded newline or
    // encoded "Domain:" prefix.
    expect(href).toContain("body=");
    expect(href).toMatch(/Domain%3A/);
  });

  it("handles an empty domain gracefully", () => {
    const href = buildOfficialSubmissionMailto("");
    expect(href.startsWith("mailto:hello@unbrowse.ai?")).toBe(true);
    // Placeholder shows up encoded.
    expect(href).toMatch(/your-domain|%3Cdomain%3E/);
  });
});

describe("/claim design guard-rails", () => {
  it("contains no em-dash characters anywhere in user-visible text", () => {
    // U+2014 EM DASH banned per CLAUDE.md design law. The source file
    // contains JSX strings as well as TS code, all of which must avoid it.
    expect(pageSource.includes("—")).toBe(false);
    expect(clientSource.includes("—")).toBe(false);
  });

  it("does not use dangerouslySetInnerHTML (XSS guard)", () => {
    // React's JSX-curly interpolation escapes by default; a script-in-a-
    // domain-field value renders as text. The only way the page could
    // execute injected HTML is via dangerouslySetInnerHTML, which is
    // banned here. This is the structural pin that React's default
    // escaping stays in force.
    expect(pageSource.includes("dangerouslySetInnerHTML")).toBe(false);
  });

  it("does not stamp out an identical 3-card grid", () => {
    // The CLAUDE.md design law bans the "3 equal cards" template. The
    // three sections must each have a distinct layout primitive (different
    // border / background / padding shape), not three siblings of an
    // identical card class. We pin this by requiring each section to have
    // a DIFFERENT className opener.
    const sectionClassNames = [
      ...pageSource.matchAll(/<section[^>]*?className="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(sectionClassNames.length).toBeGreaterThanOrEqual(3);
    const distinct = new Set(sectionClassNames);
    // Three or more <section> tags, at least three distinct className shapes.
    expect(distinct.size).toBeGreaterThanOrEqual(3);
  });

  it("uses min-h-[100dvh] not h-screen on the main wrapper", () => {
    // CLAUDE.md: viewport min-h-[100dvh] not h-screen.
    expect(pageSource).toMatch(/min-h-\[100dvh\]/);
    expect(pageSource).not.toMatch(/\bh-screen\b/);
  });
});

describe("/claim XSS pin: React JSX uses interpolation, not raw HTML", () => {
  it("domain + wallet inputs are bound via React state (curly-brace value)", () => {
    // The defence against `<script>` injection in form fields is that
    // React's JSX renders {value} as a text node. Pin that the inputs
    // use `value={...}` binding rather than building HTML strings.
    expect(pageSource).toMatch(/value=\{domain\}/);
    expect(pageSource).toMatch(/value=\{wallet\}/);
    expect(pageSource).toMatch(/value=\{contactEmail\}/);
  });

  it("does not template HTML through string concatenation in JSX", () => {
    // Catches the anti-pattern `<div>{"<b>" + name + "</b>"}</div>`. The
    // page should never concatenate `<` into JSX expressions.
    expect(pageSource).not.toMatch(/\{["'`]<[a-zA-Z]+>["'`]\s*\+/);
  });
});
