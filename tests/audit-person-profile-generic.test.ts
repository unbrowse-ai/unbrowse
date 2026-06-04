import { describe, expect, it } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

// Audit regression-guard for the X profile per-host extractor removal.
//
// the platform-faithful rule (CLAUDE.md "Ranker philosophy: heuristics OUT"
// + "Anti-patterns: per-domain heuristics that don't generalise"): no
// `host === "x.com"`, no `host === "twitter.com"`, no `x.com` literal in
// extractor code, no hardcoded `https://x.com/${username}` URL fallback.
// The generic primitive subsumes the prior behaviour by reading universal
// web standards:
//
//   - JSON-LD `schema.org/Person` — emitted by Mastodon profile pages,
//     About.me, many federated social platforms, structured-data-conformant
//     personal sites. Highest confidence.
//   - OpenGraph `og:type="profile"` with `profile:username`,
//     `profile:first_name`, `profile:last_name` — the Facebook Open Graph
//     "profile" object type (https://ogp.me/#type_profile). Used widely.
//   - Twitter card meta (`twitter:title`, `twitter:description`,
//     `twitter:creator`) + canonical URL with a `/{handle}` last segment.
//     This subsumes the X/Twitter case AND any platform that emits an
//     OG/Twitter card for a user page (Bluesky, Threads, etc).
//
// Same code path therefore handles X/Twitter AND Mastodon AND any platform
// with no per-host arms.

describe("audit/person-profile-generic: per-host X profile extractor replaced by JSON-LD Person / OG profile primitive", () => {
  it("extracts a person profile from JSON-LD schema.org/Person (any host)", () => {
    // Standards-conformant Mastodon-style profile page whose only
    // structured signal is JSON-LD Person. No `x.com` literal.
    const html = `<!doctype html><html><head>
        <title>Alex Park (@alexpark@social.example) - Social Example</title>
        <link rel="canonical" href="https://social.example/@alexpark" />
        <meta property="og:title" content="Alex Park (@alexpark@social.example)" />
        <meta property="og:url" content="https://social.example/@alexpark" />
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Person",
          "name": "Alex Park",
          "alternateName": "alexpark",
          "url": "https://social.example/@alexpark",
          "description": "Builder, agent infra, eats too many croissants.",
          "image": "https://social.example/avatars/alexpark.png"
        }
        </script>
      </head><body>
        <main><h1>Alex Park</h1></main>
      </body></html>`;

    const extracted = extractFromDOM(html, "profile for alex park user");
    expect(extracted.data).toBeTruthy();
    const data = extracted.data as Record<string, unknown>;
    expect(typeof data.name).toBe("string");
    expect(String(data.name)).toContain("Alex Park");
    expect(typeof data.username).toBe("string");
    expect(String(data.username)).toBe("alexpark");
    // URL must come from canonical/JSON-LD url, NOT a hardcoded x.com fallback.
    expect(String(data.url)).toContain("social.example");
    expect(String(data.url)).not.toContain("x.com");
    // Description should be surfaced from schema.org/description.
    if (data.description !== undefined) {
      expect(String(data.description)).toContain("croissants");
    }
  });

  it("extracts a person profile from OpenGraph og:type=profile (any host)", () => {
    // No JSON-LD Person. Only OpenGraph profile object type + canonical.
    // Same code path subsumes the prior X.com case which used og:title +
    // canonical-with-handle.
    const html = `<!doctype html><html><head>
        <title>Dana Iyer (@daniyer) / Microblog</title>
        <link rel="canonical" href="https://microblog.example/daniyer" />
        <meta property="og:type" content="profile" />
        <meta property="og:title" content="Dana Iyer (@daniyer) / Microblog" />
        <meta property="og:description" content="Engineer. Climber. Posting about agents and rope physics." />
        <meta property="og:url" content="https://microblog.example/daniyer" />
        <meta property="profile:username" content="daniyer" />
        <meta property="profile:first_name" content="Dana" />
        <meta property="profile:last_name" content="Iyer" />
        <meta name="twitter:title" content="Dana Iyer (@daniyer) / Microblog" />
        <meta name="twitter:description" content="Engineer. Climber. Posting about agents and rope physics." />
      </head><body>
        <main><h1>Dana Iyer</h1></main>
      </body></html>`;

    const extracted = extractFromDOM(html, "user profile daniyer");
    expect(extracted.data).toBeTruthy();
    const data = extracted.data as Record<string, unknown>;
    expect(String(data.name)).toContain("Dana Iyer");
    expect(String(data.username)).toBe("daniyer");
    // URL is canonical/OG, never a hardcoded host fallback.
    expect(String(data.url)).toContain("microblog.example");
    expect(String(data.url)).not.toContain("x.com");
    expect(String(data.url)).not.toContain("twitter.com");
    // Description sourced from og:description universally.
    if (data.description !== undefined) {
      expect(String(data.description)).toContain("rope physics");
    }
  });

  it("returns cleanly when no Person JSON-LD, no profile OG, no handle signal", () => {
    // Generic landing page with NO person-profile signals. The primitive
    // must NOT invent a fake person key-value row from unrelated DOM noise.
    const html = `<!doctype html><html><head>
        <title>Cool Startup Landing</title>
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Cool Startup — sell more pickles" />
      </head><body>
        <main>
          <h1>Welcome</h1>
          <p>We sell pickles online. Not a profile page.</p>
          <button>Buy now</button>
        </main>
      </body></html>`;

    const extracted = extractFromDOM(html, "profile for cool startup user");
    expect(extracted).toBeTruthy();
    // The person-profile primitive must NOT have populated a fake
    // {name, username, url} row off of this marketing page. If anything
    // else extracted (metadata fallback, etc.) that's fine.
    if (extracted.data && typeof extracted.data === "object" && !Array.isArray(extracted.data)) {
      const data = extracted.data as Record<string, unknown>;
      // No spurious username — the page has no profile signal.
      if (typeof data.username === "string") {
        // If username surfaced from anywhere, it cannot be a fabricated
        // identifier — must come from a real signal on the page.
        expect(data.username.length).toBe(0);
      }
    }
  });
});
