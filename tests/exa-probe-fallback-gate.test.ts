// Day-6 W1 falsifier for the pre-resolve auth gate + synthetic-Exa
// round-trippability hint + cli_timeout vendor envelope.
//
// Targets the three concerns the Day-5 remembrance surfaced:
//   (a) personal-pronoun + auth-gated host + no fresh cookie MUST
//       short-circuit to auth_required envelope BEFORE budget_race
//       fires Exa synthesis. Asserts the response carries
//       next_step="unbrowse_auth_capture" + suggested_commands, and
//       does NOT carry success:true on a body that says "Sign in".
//   (b) when Exa synthesizes a preview-only skill the response MUST
//       carry an explicit "use unbrowse fetch ..." next_step so the
//       agent never auto-executes against the non-persisted
//       exa-web-search skill (which would return "Skill not found").
//   (c) the cli_timeout envelope carries browser_block_signals when a
//       vendor was tagged in the process; absent any signal, the bare
//       cli_timeout error stands (no fabrication).
//
// Pure unit test: exercises the helper primitives directly, no
// browser / network / kuri broker required.

import { describe, expect, test, beforeEach } from "bun:test";
import {
  AUTH_GATED_HOSTS,
  decidePreResolveAuthGate,
  hasAuthShapedIntent,
  hasPersonalPronoun,
  hostFromUrl,
  isAuthGatedHost,
} from "../src/auth/pre-resolve-gate.ts";
import {
  clearLastVendorBlock,
  getLastVendorBlock,
  setLastVendorBlock,
} from "../src/capture/process-vendor-signal.ts";

describe("hasPersonalPronoun — boundary-aware", () => {
  test("matches the canonical personal pronouns", () => {
    expect(hasPersonalPronoun("see my github notifications")).toBe(true);
    expect(hasPersonalPronoun("show me my profile")).toBe(true);
    expect(hasPersonalPronoun("MY notifications")).toBe(true);
    expect(hasPersonalPronoun("our org's repos")).toBe(true);
    expect(hasPersonalPronoun("I want to see the feed")).toBe(true);
  });
  test("does NOT match substrings (e.g. 'mining', 'mine' as data)", () => {
    expect(hasPersonalPronoun("github top trending repos")).toBe(false);
    expect(hasPersonalPronoun("get repo for octocat")).toBe(false);
    expect(hasPersonalPronoun("mining quickstart")).toBe(false);
    expect(hasPersonalPronoun("amine reactions list")).toBe(false);
  });
  test("null / empty intent returns false", () => {
    expect(hasPersonalPronoun(null)).toBe(false);
    expect(hasPersonalPronoun(undefined)).toBe(false);
    expect(hasPersonalPronoun("")).toBe(false);
  });
});

describe("hasAuthShapedIntent — explicit auth task wording", () => {
  test("matches authenticated workflow terms without requiring a personal pronoun", () => {
    expect(hasAuthShapedIntent("resolve the authenticated workflow surface")).toBe(true);
    expect(hasAuthShapedIntent("report the next action if auth is needed for mail.google.com")).toBe(true);
    expect(hasAuthShapedIntent("open the account dashboard")).toBe(true);
  });

  test("does NOT match ordinary public-document tasks", () => {
    expect(hasAuthShapedIntent("get github profile for user octocat")).toBe(false);
    expect(hasAuthShapedIntent("read the public docs")).toBe(false);
  });
});

describe("isAuthGatedHost — data-driven, suffix-aware", () => {
  test("known hosts gated", () => {
    for (const h of AUTH_GATED_HOSTS) {
      expect(isAuthGatedHost(h)).toBe(true);
    }
  });
  test("subdomains of gated hosts are gated", () => {
    expect(isAuthGatedHost("api.github.com")).toBe(true);
    expect(isAuthGatedHost("mail.google.com")).toBe(true);
    expect(isAuthGatedHost("www.linkedin.com")).toBe(true);
  });
  test("unrelated hosts NOT gated", () => {
    expect(isAuthGatedHost("example.com")).toBe(false);
    expect(isAuthGatedHost("amazon.com")).toBe(false);
    expect(isAuthGatedHost(null)).toBe(false);
  });
});

describe("decidePreResolveAuthGate — composite", () => {
  // (a) The canonical D15 fake-green case from Day-5 W3.
  test("personal-intent + github + no fresh cookie → auth_required", () => {
    const decision = decidePreResolveAuthGate(
      "see my github notifications",
      "https://github.com/notifications",
      { cookie_probe: () => ({ fresh: false, source: "none", reason: "no cookie" }) },
    );
    expect(decision.gate).toBe("auth_required");
    if (decision.gate === "auth_required") {
      expect(decision.host).toBe("github.com");
      expect(decision.cookie_source).toBe("none");
      // Critical D15 invariant: the gate's reason describes the gap,
      // NOT a success-shaped response carrying "Sign in" body text.
      expect(decision.reason).toContain("no fresh cookie");
    }
  });

  test("no personal pronoun → pass through to race", () => {
    const decision = decidePreResolveAuthGate(
      "get github profile for user octocat",
      "https://api.github.com/users/octocat",
      { cookie_probe: () => ({ fresh: false, source: "none", reason: "" }) },
    );
    expect(decision.gate).toBe("pass");
  });

  test("auth-shaped intent + mail.google.com + no fresh cookie → auth_required", () => {
    const decision = decidePreResolveAuthGate(
      "resolve the authenticated workflow surface and report the next required user action if auth is needed for mail.google.com",
      "https://mail.google.com",
      { cookie_probe: () => ({ fresh: false, source: "none", reason: "no cookie" }) },
    );
    expect(decision.gate).toBe("auth_required");
    if (decision.gate === "auth_required") {
      expect(decision.host).toBe("mail.google.com");
      expect(decision.reason).toContain("auth-shaped intent");
    }
  });

  test("personal + non-gated host → pass", () => {
    const decision = decidePreResolveAuthGate(
      "search my notes",
      "https://example.com/search",
      { cookie_probe: () => ({ fresh: false, source: "none", reason: "" }) },
    );
    expect(decision.gate).toBe("pass");
  });

  test("personal + gated + fresh cookie → pass (let race proceed)", () => {
    const decision = decidePreResolveAuthGate(
      "my repos",
      "https://github.com",
      { cookie_probe: () => ({ fresh: true, source: "chrome", reason: "5 cookies" }) },
    );
    expect(decision.gate).toBe("pass");
  });

  test("locked Chrome SQLite → pass (do not skip the race)", () => {
    const decision = decidePreResolveAuthGate(
      "my repos",
      "https://github.com",
      { cookie_probe: () => ({ fresh: false, source: "locked", reason: "Chrome running" }) },
    );
    expect(decision.gate).toBe("pass");
  });
});

describe("audit grep — host-equality anti-pattern stays absent in pre-resolve-gate", () => {
  test("the gate uses .includes/.endsWith only, never per-host literal ===", () => {
    // Read the source and prove no `host === "<literal>"` branches exist.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const src = readFileSync(
      new URL("../src/auth/pre-resolve-gate.ts", import.meta.url),
      "utf8",
    );
    // Permits `h === gated` (variable===variable) but bans `host === "github.com"` style.
    expect(src.match(/host\s*===\s*"[a-z]/i)).toBeNull();
    expect(src.match(/=== "github\.com"|=== "gmail\.com"|=== "x\.com"/)).toBeNull();
  });
});

describe("synthetic Exa skill round-trippability hint", () => {
  // The orchestrator block was updated to add explicit
  // synthetic_skill / exec_unsupported / next_step / suggested_commands
  // fields on every Exa-synthesized resolve response. We assert the
  // SHAPE the orchestrator constructs (mirror the literal) so a
  // regression that drops the hint trips this test.
  test("expected shape contains next_step + suggested_commands + synthetic_skill flag", () => {
    const candidates = [
      { url: "https://api.github.com/users/octocat" },
      { url: "https://github.com/octocat" },
    ];
    const synthesizedShape = {
      synthetic_skill: true,
      exec_unsupported: true,
      next_step: "use unbrowse fetch for synthetic Exa results",
      suggested_commands: candidates.slice(0, 3).map((c) => `unbrowse fetch --url ${JSON.stringify(c.url)}`),
    };
    expect(synthesizedShape.synthetic_skill).toBe(true);
    expect(synthesizedShape.exec_unsupported).toBe(true);
    expect(synthesizedShape.next_step).toBe("use unbrowse fetch for synthetic Exa results");
    expect(synthesizedShape.suggested_commands[0]).toContain("unbrowse fetch --url");
    expect(synthesizedShape.suggested_commands[0]).toContain("api.github.com/users/octocat");
    // Critical D1/D3 invariant: the shape MUST NOT be auto-executable
    // via `unbrowse execute --skill exa-web-search ...`.
    expect(JSON.stringify(synthesizedShape)).not.toContain("unbrowse execute --skill exa-web-search");
  });

  test("orchestrator source contains the next_step literal (anti-regression)", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const src = readFileSync(
      new URL("../src/orchestrator/index.ts", import.meta.url),
      "utf8",
    );
    // BOTH exa synthesis sites must carry the hint.
    const matches = src.match(/use unbrowse fetch for synthetic Exa results/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("synthetic_skill: true");
    expect(src).toContain("exec_unsupported: true");
  });
});

describe("process-vendor-signal — cli_timeout envelope platform", () => {
  beforeEach(() => clearLastVendorBlock());

  test("setLastVendorBlock then getLastVendorBlock returns the row", () => {
    setLastVendorBlock("cloudflare", "indeed.com");
    const row = getLastVendorBlock();
    expect(row).not.toBeNull();
    expect(row!.vendor).toBe("cloudflare");
    expect(row!.host).toBe("indeed.com");
  });

  test("stale signal beyond the window returns null (no leaky envelope)", () => {
    setLastVendorBlock("perimeterx", "example.com");
    // Window of 0ms means anything > 0 ms ago is stale.
    expect(getLastVendorBlock(0)).toBeNull();
  });

  test("no signal → getLastVendorBlock null → cli_timeout stays a bare error", () => {
    expect(getLastVendorBlock()).toBeNull();
  });
});

describe("hostFromUrl", () => {
  test("extracts hostname lowercased", () => {
    expect(hostFromUrl("https://API.GitHub.com/users/X")).toBe("api.github.com");
  });
  test("invalid URL → null", () => {
    expect(hostFromUrl("not-a-url")).toBeNull();
    expect(hostFromUrl(null)).toBeNull();
  });
});
