/**
 * Witness: the wallet collects ALL auth/identity material, every secret sealed to the key.
 * Only the holder reveals; a wrong wallet fails closed; nothing is stored in the clear.
 */
import { test, expect } from "bun:test";
import { AuthVault, type AuthKind } from "../src/values/auth-vault.js";

const WALLET = "holder-key-1111";
const WRONG = "holder-key-2222";

test("collects every kind of auth/identity material, all sealed to the wallet", async () => {
  const v = new AuthVault();
  const items: Array<[AuthKind, string, string]> = [
    ["password", "github.com", "hunter2"],
    ["username", "github.com", "octocat"],
    ["token", "api.stripe.com", "sk_live_abc"],
    ["cookie", "x.com", "auth_token=zzz"],
    ["header", "api.openai.com", "Bearer sk-..."],
    ["apikey", "exa.ai", "exa-key-123"],
  ];
  for (const [kind, name, value] of items) await v.collect(kind, name, value, WALLET);

  expect(v.size).toBe(6);
  expect(v.kinds().sort()).toEqual(["apikey", "cookie", "header", "password", "token", "username"]);

  // the holder reveals each original value
  for (const [kind, name, value] of items) {
    expect(await v.reveal(kind, name, WALLET)).toBe(value);
  }
});

test("a wrong wallet cannot reveal anything (fails closed)", async () => {
  const v = new AuthVault();
  await v.collect("password", "bank.com", "s3cret", WALLET);
  expect(await v.reveal("password", "bank.com", WRONG)).toBeUndefined();
  expect(await v.reveal("password", "bank.com", WALLET)).toBe("s3cret");
});

test("unknown entries reveal undefined; commitments leak no value", async () => {
  const v = new AuthVault();
  await v.collect("token", "site.com", "tok", WALLET);
  expect(await v.reveal("token", "missing.com", WALLET)).toBeUndefined();
  expect(v.has("token", "site.com")).toBe(true);
  const c = v.commitmentOf("token", "site.com");
  expect(typeof c).toBe("string");
  expect(c).not.toContain("tok"); // the commitment is opaque
});
