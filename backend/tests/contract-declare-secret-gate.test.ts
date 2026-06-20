/**
 * Privacy invariant: a /contract declare row carries SHAPE + POINTERS, never
 * a raw secret string. The global-mirror only email-redacts, so a secret-
 * shaped token in plan/action/learning would land verbatim on the IQ ledger.
 *
 * The guard REJECTS (does not redact) — the CLI signs the canonical body, so
 * server-side mutation would invalidate the signature; a clean rejection keeps
 * the signed body intact.
 *
 * Witnesses:
 *   (a) secret-shaped plan      → 400 { error: "secret_in_declare", field } ; nothing appended
 *   (b) clean intent prose      → 200 + appended
 *   (c) real resolve-declare    → 200 (no false positive)
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  contractRoutes,
  valueLooksLikeSecret,
} from "../src/routes/contract";

function mountApp() {
  const app = new Hono();
  app.route("/v1", contractRoutes);
  return app;
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function status(app: Hono, id: string) {
  const res = await app.fetch(
    new Request(`http://test.local/v1/contract/status?id=${id}`, { method: "GET" }),
  );
  return { status: res.status, json: (await res.json()) as { rows: unknown[] } };
}

describe("valueLooksLikeSecret — unit", () => {
  test("flags clear secret shapes", () => {
    expect(valueLooksLikeSecret("sk-" + "a".repeat(40))).toBe(true);
    expect(valueLooksLikeSecret("Authorization: Bearer abc.def.ghijklmnop")).toBe(true);
    expect(valueLooksLikeSecret("AKIA" + "ABCD1234EFGH5678")).toBe(true);
    expect(valueLooksLikeSecret("ghp_" + "a".repeat(36))).toBe(true);
    // long base64 token embedded in prose
    expect(
      valueLooksLikeSecret("here is the token " + "A".repeat(44) + "=="),
    ).toBe(true);
    // jwt
    expect(
      valueLooksLikeSecret(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      ),
    ).toBe(true);
  });

  test("does NOT flag normal intent prose", () => {
    expect(valueLooksLikeSecret("list quotes from the quotes site")).toBe(false);
    expect(
      valueLooksLikeSecret(
        'resolve intent="list quotes" domain=quotes.toscrape.com settlement=settled',
      ),
    ).toBe(false);
    expect(valueLooksLikeSecret("satisfied:deadbeef — proof landed via real run")).toBe(false);
    expect(valueLooksLikeSecret("decalogue:purge:3")).toBe(false);
  });
});

describe("/v1/contract/declare — secret-reject guard", () => {
  test("(a) secret-shaped plan → 400 secret_in_declare, nothing appended", async () => {
    const app = mountApp();
    const fakeKey = "sk-" + "x".repeat(48);
    const { status: code, json } = await postJson(app, "/v1/contract/declare", {
      plan: `use this key ${fakeKey} to call the api`,
      action: "neuron",
    });
    expect(code).toBe(400);
    expect(json.error).toBe("secret_in_declare");
    expect(json.field).toBe("plan");
    // No id is returned → nothing was appended.
    expect(json.id).toBeUndefined();
  });

  test("(a') secret-shaped learning field also rejected", async () => {
    const app = mountApp();
    const { status: code, json } = await postJson(app, "/v1/contract/declare", {
      plan: "clean intent prose plan",
      action: "neuron",
      learning: "the AKIAABCD1234EFGH5678 root key worked",
    });
    expect(code).toBe(400);
    expect(json.error).toBe("secret_in_declare");
    expect(json.field).toBe("learning");
  });

  test("(b) clean declare → 200 + appended + readable", async () => {
    const app = mountApp();
    const { status: code, json } = await postJson(app, "/v1/contract/declare", {
      plan: "list quotes from the quotes site and rank them",
      action: "neuron",
    });
    expect(code).toBe(200);
    const id = json.id as string;
    expect(typeof id).toBe("string");
    const { json: st } = await status(app, id);
    expect(st.rows.length).toBeGreaterThan(0);
  });

  test("(c) real resolve-declare plan → 200 (no false positive)", async () => {
    const app = mountApp();
    const { status: code, json } = await postJson(app, "/v1/contract/declare", {
      plan: 'resolve intent="list quotes" domain=quotes.toscrape.com settlement=settled',
      action: "neuron",
    });
    expect(code).toBe(200);
    expect(typeof json.id).toBe("string");
  });
});
