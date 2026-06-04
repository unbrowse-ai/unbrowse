import { describe, expect, test } from "bun:test";

// Mirror the multi-segment A8 logic from src/execution/index.ts and
// src/orchestrator/index.ts. Both branches now allow N differing segments
// when every diff pair is entity-shaped on both sides. Pre-fix only
// diffCount===1 substituted, so reddit r/{sub}/comments/{id}/{slug} URLs
// (3 differing segments) silently kept the captured literals.

const SHARED = new Set([
  "api", "v1", "v2", "v3", "graphql", "rest", "rpc", "data", "json",
  "wiki", "user", "users", "post", "posts", "item", "items", "page",
  "pages", "search", "find", "list", "feed", "home", "hot", "top",
  "new", "best", "details", "detail", "info", "profile", "profiles",
  "collection", "collections", "product", "products", "p", "i", "s",
]);

function rewrite(captured: string, contextUrl: string): string | null {
  const cap = new URL(captured);
  const ctx = new URL(contextUrl);
  if (cap.hostname !== ctx.hostname) return null;
  const cs = cap.pathname.split("/").filter(Boolean);
  const xs = ctx.pathname.split("/").filter(Boolean);
  if (cs.length !== xs.length || cs.length === 0) return null;
  const diffIndices: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    if (cs[i].toLowerCase() !== xs[i].toLowerCase()) diffIndices.push(i);
  }
  if (diffIndices.length === 0) return null;
  const allEntity = diffIndices.every((i) => {
    const a = cs[i].toLowerCase();
    const b = xs[i].toLowerCase();
    const aOk = !SHARED.has(a) && a.length >= 3 && !/^\d+$/.test(a);
    const bOk = !SHARED.has(b) && b.length >= 3 && !/^\d+$/.test(b);
    return aOk && bOk;
  });
  if (!allEntity) return null;
  return `${cap.protocol}//${cap.hostname}${cap.port ? `:${cap.port}` : ""}${ctx.pathname}${cap.search}${cap.hash}`;
}

describe("A8 multi-segment entity substitution", () => {
  test("reddit /r/{sub}/comments/{id}/{slug} — 3 differing segments now substitutes", () => {
    const out = rewrite(
      "https://www.reddit.com/r/programming/comments/abc/foo/",
      "https://www.reddit.com/r/singularity/comments/xyz/bar/",
    );
    expect(out).toBe("https://www.reddit.com/r/singularity/comments/xyz/bar/");
  });

  test("wikipedia single-segment substitution still works (regression)", () => {
    const out = rewrite(
      "https://en.wikipedia.org/wiki/Quantum_computing",
      "https://en.wikipedia.org/wiki/Transformer",
    );
    expect(out).toBe("https://en.wikipedia.org/wiki/Transformer");
  });

  test("github user profile single-segment", () => {
    const out = rewrite(
      "https://github.com/torvalds",
      "https://github.com/anthropics",
    );
    expect(out).toBe("https://github.com/anthropics");
  });

  test("differs in shared-only segment — no substitution (avoid stomping API path)", () => {
    // /api/v1 and /api/v2 differ only in shared tokens
    const out = rewrite(
      "https://example.com/api/v1/users",
      "https://example.com/api/v2/users",
    );
    expect(out).toBeNull();
  });

  test("differs in length — no substitution", () => {
    const out = rewrite(
      "https://example.com/users/123/posts",
      "https://example.com/users/123",
    );
    expect(out).toBeNull();
  });

  test("identical paths — no rewrite needed", () => {
    const out = rewrite(
      "https://example.com/foo/bar",
      "https://example.com/foo/bar",
    );
    expect(out).toBeNull();
  });
  test("preserves captured query string", () => {
    const out = rewrite(
      "https://www.reddit.com/r/programming/comments/abc/foo/?limit=10",
      "https://www.reddit.com/r/singularity/comments/xyz/bar/",
    );
    expect(out).toBe("https://www.reddit.com/r/singularity/comments/xyz/bar/?limit=10");
  });
});
