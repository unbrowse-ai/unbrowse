/**
 * iproyal-sticky-persist.test — the cross-process-stable sticky session id.
 *
 * Root cause of the rootdata WAF re-challenge: `unbrowse auth` (process A) solves
 * the captcha on residential IP X, but `unbrowse fetch` (process B) rolled a fresh
 * per-process-random IProyal session → a DIFFERENT IP → the IP-bound clearance is
 * worthless and the WAF re-challenges. Persisting the session id to disk makes
 * A and B exit from the SAME IP. These tests lock that behaviour.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stickySessionId, iproyalStickySuffix } from "../src/execution/proxy-fetch.js";

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "unbrowse-sticky-"));
}

test("two separate resolutions (simulating two processes) reuse the SAME persisted id", () => {
  const dir = freshStateDir();
  try {
    const envA = { UNBROWSE_STATE_DIR: dir } as NodeJS.ProcessEnv;
    const envB = { UNBROWSE_STATE_DIR: dir } as NodeJS.ProcessEnv;
    const idA = stickySessionId(envA); // process A mints + persists
    const idB = stickySessionId(envB); // process B reads the same file
    expect(idA).toMatch(/^[0-9a-f]{8}$/);
    expect(idB).toBe(idA);
    expect(existsSync(join(dir, "iproyal-session.json"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UNBROWSE_IPROYAL_SESSION overrides persistence verbatim", () => {
  const dir = freshStateDir();
  try {
    const env = { UNBROWSE_STATE_DIR: dir, UNBROWSE_IPROYAL_SESSION: "pinned123" } as NodeJS.ProcessEnv;
    expect(stickySessionId(env)).toBe("pinned123");
    // explicit pin must not write the persistence file
    expect(existsSync(join(dir, "iproyal-session.json"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UNBROWSE_IPROYAL_SESSION_PERSIST=0 opts out of disk persistence", () => {
  const dir = freshStateDir();
  try {
    const env = { UNBROWSE_STATE_DIR: dir, UNBROWSE_IPROYAL_SESSION_PERSIST: "0" } as NodeJS.ProcessEnv;
    const id = stickySessionId(env);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(existsSync(join(dir, "iproyal-session.json"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("iproyalStickySuffix embeds the persisted session id", () => {
  const dir = freshStateDir();
  try {
    const env = { UNBROWSE_STATE_DIR: dir } as NodeJS.ProcessEnv;
    const id = stickySessionId(env);
    const suffix = iproyalStickySuffix(env);
    expect(suffix).toContain(`_session-${id}`);
    expect(suffix).toContain("_lifetime-30m");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit opt-out (UNBROWSE_IPROYAL_STICKY=0) yields a rotating (empty) suffix", () => {
  const env = { UNBROWSE_IPROYAL_STICKY: "0" } as NodeJS.ProcessEnv;
  expect(iproyalStickySuffix(env)).toBe("");
});
