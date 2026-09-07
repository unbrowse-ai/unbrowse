/**
 * IProyal residential proxy wiring — the network-descent egress.
 *
 * One creds file (~/.identity/iproyal-creds) now drives BOTH the browser/CDP
 * proxy and the HTTP-fetch egress: resolveProxyUrl falls back to the file when
 * env vars are absent. The secret lives in ~/.identity (mode 600), never in
 * source. This suite verifies the env path, the file fallback (mocked — no real
 * creds, no ~/.identity touch), the country-lock preservation, and the
 * resolveEgressProxy precedence.
 */
import { describe, it, expect, mock } from "bun:test";

let fileCreds: { username: string; password: string; host: string; port: number } | null = null;
mock.module("../src/cdp/proxy/iproyal.js", () => ({
  loadCredsFileSync: () => fileCreds,
}));

const { resolveProxyUrl, resolveEgressProxy } = await import("../src/execution/proxy-fetch.js");

describe("IProyal proxy wiring", () => {
  it("env creds -> IProyal URL with country-lock preserved", () => {
    fileCreds = null;
    const u = resolveProxyUrl({ IPROYAL_USER: "u1", IPROYAL_PASS: "p1_country-my" } as NodeJS.ProcessEnv);
    expect(u).toBe("http://u1:p1_country-my@geo.iproyal.com:12321");
  });

  it("no env -> falls back to the creds FILE (one file drives both paths)", () => {
    fileCreds = { username: "fu", password: "fp_country-my", host: "geo.iproyal.com", port: 12321 };
    const u = resolveProxyUrl({} as NodeJS.ProcessEnv);
    expect(u).toBe("http://fu:fp_country-my@geo.iproyal.com:12321");
  });

  it("no env + no file -> undefined (caller falls through to next proxy)", () => {
    fileCreds = null;
    expect(resolveProxyUrl({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("resolveEgressProxy precedence: DIRECT > UNBROWSE_PROXY_URL > IProyal(file)", () => {
    fileCreds = { username: "fu", password: "fp", host: "geo.iproyal.com", port: 12321 };
    expect(resolveEgressProxy({ UNBROWSE_DIRECT_EGRESS: "1" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveEgressProxy({ UNBROWSE_PROXY_URL: "http://x:y@h:1" } as NodeJS.ProcessEnv)).toBe("http://x:y@h:1");
    expect(resolveEgressProxy({} as NodeJS.ProcessEnv)).toContain("geo.iproyal.com:12321");
  });
});
