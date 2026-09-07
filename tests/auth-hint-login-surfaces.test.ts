// Loop 5.2: auth_hint surfaces keychain + local_browser + agent_browser
// login paths, plus a clickable web_login_url. The agent (and a human
// reading the resolve response) sees ALL THREE friction-tiers in one
// payload, not just an unbrowse-go command.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  recordStaleEndpoint,
  buildAuthHint,
  clearStaleEndpoints,
} from "../src/auth/stale-endpoints.ts";

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `unbrowse-hint-surfaces-${Date.now()}-${Math.random()}.json`);
  process.env.UNBROWSE_STALE_ENDPOINTS_PATH = tmpFile;
});

afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch {}
  delete process.env.UNBROWSE_STALE_ENDPOINTS_PATH;
});

describe("auth_hint login surfaces (Loop 5.2)", () => {
  it("surfaces web_login_url as a clickable https URL on the domain root", () => {
    recordStaleEndpoint("x.com", "ep1", 401);
    const hint = buildAuthHint("x.com");
    expect(hint).not.toBeNull();
    expect(hint!.web_login_url).toBe("https://x.com/");
    expect(hint!.web_login_url.startsWith("https://")).toBe(true);
  });

  it("includes all three login surfaces in friction order: keychain, local_browser, agent_browser", () => {
    recordStaleEndpoint("github.com", "ep1", 401);
    const hint = buildAuthHint("github.com");
    const kinds = hint!.surfaces.map((s) => s.kind);
    expect(kinds).toEqual(["keychain", "local_browser", "agent_browser"]);
  });

  it("keychain surface references kuri authProfileLoad as the substrate primitive", () => {
    recordStaleEndpoint("notion.so", "ep1", 401);
    const hint = buildAuthHint("notion.so");
    const keychain = hint!.surfaces.find((s) => s.kind === "keychain");
    expect(keychain).toBeDefined();
    expect(keychain!.description).toContain("kuri.authProfileLoad");
  });

  it("local_browser surface references the SQLite cookie extraction path", () => {
    recordStaleEndpoint("youtube.com", "ep1", 401);
    const hint = buildAuthHint("youtube.com");
    const local = hint!.surfaces.find((s) => s.kind === "local_browser");
    expect(local).toBeDefined();
    expect(local!.description).toMatch(/Dia|Chrome|SQLite/);
  });

  it("agent_browser surface carries the literal commands array", () => {
    recordStaleEndpoint("reddit.com", "ep1", 401);
    const hint = buildAuthHint("reddit.com");
    const agent = hint!.surfaces.find((s) => s.kind === "agent_browser");
    expect(agent).toBeDefined();
    expect(agent!.commands).toEqual([
      `unbrowse go "https://reddit.com/"`,
      "unbrowse snap --filter interactive",
      "unbrowse close",
    ]);
  });

  it("next_step mentions BOTH the web URL and the unbrowse command", () => {
    recordStaleEndpoint("linear.app", "ep1", 401);
    const hint = buildAuthHint("linear.app");
    expect(hint!.next_step).toContain("https://linear.app/");
    expect(hint!.next_step).toContain("unbrowse go");
  });

  it("backward-compat: still surfaces top-level `commands` (Loop 5.1 contract)", () => {
    recordStaleEndpoint("x.com", "ep1", 401);
    const hint = buildAuthHint("x.com");
    expect(Array.isArray(hint!.commands)).toBe(true);
    expect(hint!.commands.length).toBeGreaterThanOrEqual(3);
  });
});
