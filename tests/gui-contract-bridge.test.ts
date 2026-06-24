import { test, expect } from "bun:test";
import { a11yNodeToContract } from "../src/values/gui-contract-bridge";

const URL = "https://example.com/checkout";

test("a button element maps to a /contract-shaped entry (id/text/value)", () => {
  const c = a11yNodeToContract({ ref: "e0", role: "button", name: "Pay now" }, URL);
  expect(c.id.startsWith("gui-")).toBe(true);
  expect(c.text).toBe("button 'Pay now' @ https://example.com/checkout → e0");
  const v = c.value as Record<string, unknown>;
  expect(v.kind).toBe("gui-element");
  expect(v.ref).toBe("e0");
  expect(v.role).toBe("button");
  expect(v.pageUrl).toBe(URL);
});

test("deterministic: same element + page → same content-addressed id", () => {
  const a = a11yNodeToContract({ ref: "e1", role: "link", name: "Docs" }, URL);
  const b = a11yNodeToContract({ ref: "e1", role: "link", name: "Docs" }, URL);
  expect(a.id).toBe(b.id);
});

test("pointer not payload: the entry carries identity, never DOM bytes", () => {
  const c = a11yNodeToContract({ ref: "e2", role: "textbox", name: "Email", value: "a@b.com" }, URL);
  const v = c.value as Record<string, unknown>;
  // identity fields present; no html/outerHTML/dom payload field
  expect(Object.keys(v).sort()).toEqual(["kind", "name", "pageUrl", "ref", "role", "state"]);
  expect(JSON.stringify(c)).not.toContain("<");
});

test("distinct elements get distinct ids (no collision)", () => {
  const a = a11yNodeToContract({ ref: "e0", role: "button", name: "Save" }, URL);
  const b = a11yNodeToContract({ ref: "e1", role: "button", name: "Save" }, URL);
  expect(a.id).not.toBe(b.id);
});
