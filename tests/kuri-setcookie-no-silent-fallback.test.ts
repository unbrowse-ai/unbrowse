/**
 * tests/kuri-setcookie-no-silent-fallback.test.ts
 *
 * Regression test for B-023 / F3: when the CDP debugger target for a tab
 * cannot be resolved (e.g. freshly-spawned tab not yet in /json listing,
 * or no chrome listening at all), setCookie MUST NOT silently fall through
 * to the legacy /cookies endpoint for secure/httpOnly cookies — that
 * fallback strips the secure/httpOnly flags and the caller would think
 * the cookie was persisted when it was not.
 *
 * The fix: setCookie throws a descriptive error so the caller
 * (importBrowserCookiesIntoTab) can log the loss instead of swallowing it.
 *
 * No mocks: we drive a fake tabId that no real chrome will ever advertise
 * in its /json listing, and point kuriCdpPort at a free local port so the
 * primary CDP discovery attempt fails fast. Retry delays are forced to a
 * single attempt via UNBROWSE_KURI_CDP_RESOLVE_RETRY_MS=0 so the test
 * doesn't pay the 500ms backoff budget per call.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setCookie, setCdpPortForTests, type KuriCookie } from "../src/kuri/client.js";

const FAKE_TAB_ID = "B023_fake_tab_id_that_no_real_chrome_advertises_xyz";
const FREE_PROBE_PORT = 1; // privileged, guaranteed connect refused / unbindable

const originalRetryEnv = process.env.UNBROWSE_KURI_CDP_RESOLVE_RETRY_MS;
const originalCdpPort = process.env.KURI_CDP_PORT;

beforeAll(() => {
  // Force a single CDP-resolve attempt so the test runs in well under 2s
  // even if 9222-9225 host a real chrome that we have to poll past.
  process.env.UNBROWSE_KURI_CDP_RESOLVE_RETRY_MS = "0";
  // Point internal cache at a port nothing listens on so the first probe
  // fails immediately. The function still falls through 9222-9225, but
  // the fake tab id is never advertised by any real chrome, so they all
  // return null too.
  setCdpPortForTests(FREE_PROBE_PORT);
});

afterAll(() => {
  if (originalRetryEnv === undefined) {
    delete process.env.UNBROWSE_KURI_CDP_RESOLVE_RETRY_MS;
  } else {
    process.env.UNBROWSE_KURI_CDP_RESOLVE_RETRY_MS = originalRetryEnv;
  }
  if (originalCdpPort === undefined) {
    delete process.env.KURI_CDP_PORT;
  } else {
    process.env.KURI_CDP_PORT = originalCdpPort;
  }
  setCdpPortForTests(null);
});

function secureCookie(overrides: Partial<KuriCookie> = {}): KuriCookie {
  return {
    name: "B023_session",
    value: "secret",
    domain: ".example.test",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "Lax",
    ...overrides,
  };
}

describe("kuri.setCookie — no silent fallback for secure cookies (B-023 / F3)", () => {
  it("throws when CDP target cannot be resolved for a secure cookie", async () => {
    await expect(setCookie(FAKE_TAB_ID, secureCookie({ secure: true, httpOnly: false })))
      .rejects.toThrow(/no CDP websocket for tab/i);
  }, 10_000);

  it("throws when CDP target cannot be resolved for an httpOnly cookie", async () => {
    await expect(setCookie(FAKE_TAB_ID, secureCookie({ secure: false, httpOnly: true })))
      .rejects.toThrow(/no CDP websocket for tab/i);
  }, 10_000);

  it("error message names the lost cookie + tab + domain (operator-actionable)", async () => {
    const cookie = secureCookie({ name: "B023_named_cookie", domain: ".linkedin.com", secure: true });
    let thrown: unknown = null;
    try {
      await setCookie(FAKE_TAB_ID, cookie);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain(FAKE_TAB_ID);
    expect(msg).toContain("B023_named_cookie");
    expect(msg).toContain(".linkedin.com");
    // The message must mention why we refused to fall back — so a future
    // reader knows this is not a transport bug, it is deliberate.
    expect(msg).toMatch(/strips|cannot persist|fallback is disabled/i);
  }, 10_000);
});
