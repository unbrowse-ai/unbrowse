/**
 * Doc-citation falsifier for the three Step-3 firmament docs:
 *   docs/HOW_UNBROWSE_PAYS.md
 *   docs/EARN_AS_INDEXER.md
 *   docs/CLAIM_YOUR_DOMAIN.md
 *
 * Every `path/to/file.ts`, `path/to/file.ts:42`, and `path/to/file.ts:42-87`
 * citation in those docs must resolve to a real on-disk file, and any line
 * number must be within that file's length.
 *
 * Structural primitive, no per-doc whitelist of "known good" citations: we
 * extract the raw citation tokens, filter URL/package-shorthand/non-path
 * noise via shape rules, then resolve every survivor against the repo root.
 *
 * Aggregates every failure into one assertion so a future doc-rot regression
 * shows the full list in one read. No mocks, real filesystem.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const DOCS = [
  "docs/HOW_UNBROWSE_PAYS.md",
  "docs/EARN_AS_INDEXER.md",
  "docs/CLAIM_YOUR_DOMAIN.md",
  // 2026-05-18 follow-up: concept-level docs added alongside the
  // sabbath-verdict cleanup. Same citation discipline as Step-3 docs.
  // (docs/sdk/rewards-and-economics.md uses bare-filename SUMMARY refs
  // like `layer.md` which the regex treats as repo-relative paths and
  // misclassifies; it's covered by the SDK doc test harness, not here.)
  "docs/concepts/fare-splits.md",
  "docs/concepts/claiming-a-website.md",
];

// Extension allowlist: only citations ending in a real source extension
// participate. Notes on the regex:
//   - Lookbehind `(?<![A-Za-z0-9_/@:.])` keeps the match from starting mid-
//     URL (`https://example.com/foo.ts`), mid-scoped-package (`@scope/x.ts`),
//     or mid-identifier. URLs and package shorthand are the noise we mostly
//     have to suppress.
//   - Optional leading `\.?` so dotfiles / dot-prefixed dirs like
//     `.claude/firmament-step2.md` survive the `[A-Za-z]`-must-be-first rule.
//   - Longer extensions FIRST (tsx before ts, jsx before js, mjs/cjs before
//     js) otherwise the inner alternation matches `.ts` and leaves
//     `x:205-227` dangling.
//   - `(?![A-Za-z0-9_])` after the extension prevents matches like
//     `foo.tsfile`.
const CITATION_RE =
  /(?<![A-Za-z0-9_/@:.\-])\.?[A-Za-z][\w/.-]*\.(tsx|jsx|mjs|cjs|ts|js|md|sh|json|yaml|yml|toml)(?![A-Za-z0-9_])(:\d+(?:-\d+)?)?/g;

interface RawCitation {
  doc: string;
  docLine: number;
  raw: string;        // exact substring matched (with optional :N or :N-M)
  pathPart: string;   // raw without :N or :N-M
  startLine?: number; // present when raw has :N or :N-M
  endLine?: number;   // present when raw has :N-M
}

interface CiteFailure {
  doc: string;
  docLine: number;
  raw: string;
  reason: string;
}

function isCitationLike(pathPart: string): boolean {
  // Reject URLs (http://, https://, data:, etc.). The regex above does not
  // match `://` directly but `unbrowse.ai` and `lobster.cash` slip through.
  if (pathPart.includes("://")) return false;
  // Reject npm package shorthand and email-shaped tokens.
  if (pathPart.includes("@")) return false;
  // Reject leading digit (timestamps, versions, etc).
  if (/^\d/.test(pathPart)) return false;
  // Reject domain-shaped tokens with no path separator: `unbrowse.ai`,
  // `lobster.cash`, `crates.io`, `docs.getfoundry.app`. A real repo path
  // either contains a `/` OR has a known multi-segment file extension we
  // already match, BUT bare `foo.ts` would also be valid for a flat-layout
  // repo. To be safe: if there's no `/`, require the extension to be one
  // of the source-code extensions that a flat-layout repo could plausibly
  // place at the root, AND require the basename to not look like a
  // public TLD-shaped token. We approximate "looks like a TLD" by
  // rejecting bare-domain tokens whose extension is in the docs/marketing
  // TLD set.
  if (!pathPart.includes("/")) {
    const ext = pathPart.split(".").pop()!.toLowerCase();
    // Common TLDs that collide with our extension regex: .ai .cash .io .app
    // are NOT in our extension allowlist so they never reach here. The only
    // extensions in our allowlist that are also TLD-shaped are `.md`. Bare
    // `*.md` at the repo root is plausible (README.md, CHANGELOG.md), so
    // we let those through and rely on the existsSync check.
    if (!["ts", "tsx", "md", "sh", "mjs", "cjs", "js", "jsx", "json", "yaml", "yml", "toml"].includes(ext)) {
      return false;
    }
  }
  // Reject the .well-known prefix and `_unbrowse-claim.<domain>` patterns
  // which match the regex but are DNS/spec references.
  if (pathPart.startsWith(".well-known")) return false;
  if (pathPart.startsWith("_unbrowse-claim.")) return false;
  return true;
}

function extractCitations(doc: string): RawCitation[] {
  const absDoc = resolve(REPO_ROOT, doc);
  const content = readFileSync(absDoc, "utf8");
  const lines = content.split("\n");
  const out: RawCitation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;
    let m: RegExpExecArray | null;
    CITATION_RE.lastIndex = 0;
    while ((m = CITATION_RE.exec(lineText)) !== null) {
      const raw = m[0];
      // Context-reject: if the preceding character marks the match as the
      // tail of a URL (`/`) or an npm scoped-package (`@`), drop it. This
      // catches `https://example.com/foo.ts:42` and `@scope/foo.ts` which
      // shed their disqualifying prefix from `pathPart` itself.
      const prev = m.index > 0 ? lineText[m.index - 1]! : "";
      if (prev === "/" || prev === "@") continue;
      const colonIdx = raw.lastIndexOf(":");
      let pathPart = raw;
      let startLine: number | undefined;
      let endLine: number | undefined;
      if (colonIdx > 0 && /^\d/.test(raw.slice(colonIdx + 1))) {
        pathPart = raw.slice(0, colonIdx);
        const lineSpec = raw.slice(colonIdx + 1);
        const dashIdx = lineSpec.indexOf("-");
        if (dashIdx > 0) {
          startLine = Number(lineSpec.slice(0, dashIdx));
          endLine = Number(lineSpec.slice(dashIdx + 1));
        } else {
          startLine = Number(lineSpec);
        }
      }
      if (!isCitationLike(pathPart)) continue;
      out.push({
        doc,
        docLine: i + 1,
        raw,
        pathPart,
        startLine,
        endLine,
      });
    }
  }
  return out;
}

function countLines(absPath: string): number {
  const buf = readFileSync(absPath, "utf8");
  if (buf.length === 0) return 0;
  // Last newline does not contribute an extra line; "a\nb" is 2 lines,
  // "a\nb\n" is also 2 lines.
  const n = buf.split("\n").length;
  return buf.endsWith("\n") ? n - 1 : n;
}

function validate(citations: RawCitation[]): CiteFailure[] {
  const failures: CiteFailure[] = [];
  for (const c of citations) {
    // Try repo-root resolution first (legacy Step-3 docs cite
    // backend/src/... paths). If that file doesn't exist, fall back to
    // doc-relative resolution (concept-level docs cross-link siblings
    // via bare filenames like `fare-splits.md`).
    let abs = resolve(REPO_ROOT, c.pathPart);
    if (!existsSync(abs)) {
      const docDir = dirname(resolve(REPO_ROOT, c.doc));
      const altAbs = resolve(docDir, c.pathPart);
      if (existsSync(altAbs)) abs = altAbs;
    }
    if (!existsSync(abs)) {
      failures.push({
        doc: c.doc,
        docLine: c.docLine,
        raw: c.raw,
        reason: `${c.pathPart} not found`,
      });
      continue;
    }
    // Reject directories — a doc citation is a file reference.
    if (statSync(abs).isDirectory()) {
      failures.push({
        doc: c.doc,
        docLine: c.docLine,
        raw: c.raw,
        reason: `${c.pathPart} is a directory, not a file`,
      });
      continue;
    }
    if (c.startLine != null || c.endLine != null) {
      const n = countLines(abs);
      const upper = c.endLine ?? c.startLine!;
      if (upper > n) {
        failures.push({
          doc: c.doc,
          docLine: c.docLine,
          raw: c.raw,
          reason: `${c.pathPart}:${upper} exceeds file length (${n} lines)`,
        });
        continue;
      }
      const lower = c.startLine!;
      if (lower < 1) {
        failures.push({
          doc: c.doc,
          docLine: c.docLine,
          raw: c.raw,
          reason: `${c.pathPart}:${lower} is below line 1`,
        });
        continue;
      }
      if (c.endLine != null && c.endLine < c.startLine!) {
        failures.push({
          doc: c.doc,
          docLine: c.docLine,
          raw: c.raw,
          reason: `${c.pathPart}:${c.startLine}-${c.endLine} has end before start`,
        });
        continue;
      }
    }
  }
  return failures;
}

describe("docs/Step-3 citations resolve to real file:line", () => {
  it("every cited file exists and every cited line is in range", () => {
    const all: RawCitation[] = [];
    for (const doc of DOCS) {
      all.push(...extractCitations(doc));
    }

    // Sanity: ensure the extractor actually found citations. A future
    // doc rewrite that drops every code reference would silently pass
    // this test otherwise.
    expect(all.length).toBeGreaterThan(20);

    // Sanity: ensure the nine canonical citations from the task brief
    // actually appear in the extracted set. If the regex or whitelist
    // regresses and starts dropping real citations, this fires before
    // the false-clean run.
    const canonical = [
      { path: "backend/src/services/flex.ts", start: 39 },
      { path: "backend/src/services/flex.ts", start: 54, end: 87 },
      { path: "backend/src/services/flex.ts", start: 66 },
      { path: "backend/src/types.ts", start: 437 },
      { path: "backend/src/types.ts", start: 516, end: 531 },
      // Step 5 (PR #480): the page shrank from 285 lines to 39 when it
      // became a markdown renderer. The lobster-cash citation now lives
      // in docs/HOW_UNBROWSE_PAYS.md itself; the guard pins the renderer
      // module as the new structural anchor.
      { path: "frontend/src/lib/docs-renderer.ts" },
      { path: "backend/src/routes/auth.ts", start: 53, end: 172 },
      { path: "backend/src/routes/claim.ts" },
      { path: "backend/src/services/domain-claim.ts" },
    ];
    const missing: string[] = [];
    for (const c of canonical) {
      const hit = all.find(
        (r) =>
          r.pathPart === c.path &&
          r.startLine === (c as any).start &&
          r.endLine === (c as any).end,
      );
      if (!hit) {
        const label =
          c.start == null
            ? c.path
            : (c as any).end == null
              ? `${c.path}:${c.start}`
              : `${c.path}:${c.start}-${(c as any).end}`;
        missing.push(label);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Canonical citations not extracted from docs (regex/whitelist regression):\n  ${missing.join("\n  ")}`,
      );
    }

    const failures = validate(all);
    if (failures.length > 0) {
      const lines = failures.map(
        (f) => `[doc-cite] ${f.doc}:${f.docLine} -> ${f.reason}  (raw: ${f.raw})`,
      );
      throw new Error(
        `Stale citations in Step-3 docs (${failures.length} of ${all.length} checked):\n${lines.join("\n")}`,
      );
    }

    expect(failures.length).toBe(0);
  });
});
