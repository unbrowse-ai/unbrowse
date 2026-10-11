import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clear, deviceLogin, load } from "../src/auth.ts";

const BASE = "https://api.test";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ub-dev-"));
  process.env.UNBROWSE_CONFIG_DIR = dir;
  clear();
});
afterEach(() => {
  delete process.env.UNBROWSE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** A hosted edge that answers register, device_authorization and the device-grant poll, scripted per poll. */
function edge(pollAnswers: Array<Record<string, unknown> & { _status?: number }>) {
  const log: string[] = [];
  let polls = 0;
  const reg: unknown[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/oauth/register")) {
      reg.push(JSON.parse(String(init?.body)));
      return Response.json({ client_id: "cid_device" }, { status: 201 });
    }
    if (u.endsWith("/oauth/device_authorization")) {
      return Response.json({ device_code: "dev_code_123", user_code: "WXYZ-2345", verification_uri: `${BASE}/device`, verification_uri_complete: `${BASE}/device?code=WXYZ-2345`, expires_in: 600, interval: 5 });
    }
    if (u.endsWith("/oauth/token")) {
      const a = pollAnswers[Math.min(polls, pollAnswers.length - 1)];
      polls += 1;
      const { _status, ...body } = a;
      return Response.json(body, { status: _status ?? (body.access_token ? 200 : 400) });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, log, reg, polls: () => polls };
}

const opts = (e: ReturnType<typeof edge>) => ({ log: (l: string) => e.log.push(l), fetch: e.fetchImpl, sleep: async () => {}, clientName: "Grok bot" });

test("device login: prints the code, polls past pending, and stores the tokens", async () => {
  const e = edge([{ error: "authorization_pending" }, { access_token: "ub_at", refresh_token: "ub_rt", expires_in: 3600 }]);
  await deviceLogin(BASE, opts(e));

  // The person is told where to go and what to type.
  const shown = e.log.join("\n");
  expect(shown).toContain("WXYZ-2345");
  expect(shown).toContain(`${BASE}/device`);

  // The client is registered by name so the resulting login can be revoked on its own.
  expect((e.reg[0] as { client_name: string }).client_name).toBe("Grok bot");

  // Tokens are stored against this client.
  const stored = load();
  expect(stored.oauth?.accessToken).toBe("ub_at");
  expect(stored.oauth?.refreshToken).toBe("ub_rt");
  expect(stored.oauth?.clientId).toBe("cid_device");
  expect(e.polls()).toBe(2);
});

test("device login: slow_down widens the interval and keeps polling", async () => {
  const e = edge([{ error: "slow_down" }, { error: "authorization_pending" }, { access_token: "ub_at2", expires_in: 3600 }]);
  await deviceLogin(BASE, opts(e));
  expect(load().oauth?.accessToken).toBe("ub_at2");
  expect(e.polls()).toBe(3);
});

test("device login: a denied approval throws and stores nothing", async () => {
  const e = edge([{ error: "access_denied" }]);
  await expect(deviceLogin(BASE, opts(e))).rejects.toThrow(/denied/);
  expect(load().oauth).toBeUndefined();
});

test("device login: an expired code throws with a retry hint", async () => {
  const e = edge([{ error: "expired_token" }]);
  await expect(deviceLogin(BASE, opts(e))).rejects.toThrow(/expired/);
});
