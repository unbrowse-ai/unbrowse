/**
 * GATE: the server session registry imports no kuri.
 *
 * src/api/browse-session.ts held exactly one kuri import — getKuriErrorMessage —
 * for a function that was never kuri-specific (it pulls .error / .message /
 * .result.* out of an unknown broker reply, which is the shape every broker
 * answers with). That single import pulled 2,543 lines of kuri into the registry.
 *
 * Moving it to src/api/broker-error.ts is what turns kuri from "unused on the
 * obscura path" into "deletable". This test keeps it that way: re-import kuri
 * here and it goes red.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBrokerErrorMessage } from "../src/api/broker-error.js";

const src = (rel: string) => readFileSync(join(import.meta.dirname, "..", "src", rel), "utf8");

describe("browse-session.ts is kuri-free", () => {
  test("it imports nothing from src/kuri", () => {
    const text = src("api/browse-session.ts");
    const imports = [...text.matchAll(/^\s*import[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    const kuri = imports.filter((i) => i.includes("kuri"));
    expect(kuri, `browse-session.ts must not import kuri; found: ${kuri.join(", ")}`).toEqual([]);
  });

  test("the registry's client interface names no kuri type", () => {
    const iface = src("api/browse-session.ts").match(/export interface BrowseSessionClient \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(iface).not.toContain("Kuri");
    expect(iface.length).toBeGreaterThan(50); // the match actually found the interface
  });
});

describe("extractBrokerErrorMessage is backend-agnostic", () => {
  test("reads the shapes any broker answers with", () => {
    expect(extractBrokerErrorMessage({ error: "boom" })).toBe("boom");
    expect(extractBrokerErrorMessage({ message: "msg" })).toBe("msg");
    expect(extractBrokerErrorMessage({ result: { error: "nested-e" } })).toBe("nested-e");
    expect(extractBrokerErrorMessage({ result: { message: "nested-m" } })).toBe("nested-m");
  });

  test("a bare string yields null — the caller already has the message", () => {
    expect(extractBrokerErrorMessage("already a message")).toBeNull();
  });

  test("no error present, or a non-object, yields null", () => {
    expect(extractBrokerErrorMessage({})).toBeNull();
    expect(extractBrokerErrorMessage(null)).toBeNull();
    expect(extractBrokerErrorMessage(undefined)).toBeNull();
    expect(extractBrokerErrorMessage(42)).toBeNull();
  });

  test("kuri still re-exports it, so existing callers keep working", async () => {
    const { getKuriErrorMessage } = await import("../src/kuri/client.js");
    expect(getKuriErrorMessage({ error: "boom" })).toBe("boom");
  });
});
