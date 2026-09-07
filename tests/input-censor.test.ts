/**
 * input-censor.test — the ZK input-censoring invariant (request-side).
 *
 * Sensitive write-body fields must be replaced by sha256 commitments before a
 * skill is persisted/published, while non-sensitive fields and read endpoints
 * pass through untouched. Pure-function tests (no network).
 */
import { describe, expect, it } from "bun:test";
import {
  censorInputBody,
  censorSkillForPersistence,
  isSensitiveFieldName,
  commitValue,
} from "../src/proof/input-censor.js";

describe("censorInputBody", () => {
  it("commits sensitive leaves, passes through the rest", () => {
    const { censored, commitments, didCensor } = censorInputBody({
      email: "eve@reqres.in",
      password: "pistol",
      nested: { api_key: "sk-live-123", note: "keep" },
    });
    expect(didCensor).toBe(true);
    const c = censored as Record<string, any>;
    expect(c.email).toBe("eve@reqres.in"); // untouched
    expect(c.password).toBe(commitValue("pistol")); // committed
    expect(c.nested.api_key).toBe(commitValue("sk-live-123"));
    expect(c.nested.note).toBe("keep");
    expect(commitments["password"]).toBe(commitValue("pistol"));
    expect(commitments["nested.api_key"]).toBe(commitValue("sk-live-123"));
  });

  it("treats vault-pointer values as sensitive even with a benign key", () => {
    const { censored, didCensor } = censorInputBody({ field: "arg://session_secret" });
    expect(didCensor).toBe(true);
    expect((censored as Record<string, unknown>).field).toBe(commitValue("arg://session_secret"));
  });

  it("is a no-op on a body with no sensitive fields", () => {
    const { censored, didCensor } = censorInputBody({ name: "x", n: 1 });
    expect(didCensor).toBe(false);
    expect(censored).toEqual({ name: "x", n: 1 });
  });
});

describe("isSensitiveFieldName", () => {
  it("matches common secret field names", () => {
    for (const n of ["password", "passwd", "apiKey", "api_key", "secret", "token", "cvv", "ssn", "mnemonic"]) {
      expect(isSensitiveFieldName(n)).toBe(true);
    }
  });
  it("does not match benign names", () => {
    for (const n of ["email", "name", "title", "quantity", "marker"]) {
      expect(isSensitiveFieldName(n)).toBe(false);
    }
  });
});

describe("censorSkillForPersistence", () => {
  it("censors write-endpoint bodies, leaves GET endpoints alone", () => {
    const skill = {
      skill_id: "s1",
      endpoints: [
        { endpoint_id: "w", method: "POST", url_template: "https://x/y", body: { password: "p", q: 1 } },
        { endpoint_id: "r", method: "GET", url_template: "https://x/z", query: { q: "1" } },
        { endpoint_id: "n", method: "PUT", url_template: "https://x/w" }, // no body
      ],
    };
    const { skill: out, didCensor } = censorSkillForPersistence(skill);
    expect(didCensor).toBe(true);
    const w = out.endpoints[0] as Record<string, any>;
    expect(w.body.password).toBe(commitValue("p"));
    expect(w.body.q).toBe(1);
    expect(w.input_commitments.password).toBe(commitValue("p"));
    // GET + bodyless untouched, input does not mutate
    expect(out.endpoints[1]).toEqual(skill.endpoints[1]);
    expect(skill.endpoints[0].body.password).toBe("p"); // original not mutated
  });

  it("returns the same skill unchanged when nothing is sensitive", () => {
    const skill = { skill_id: "s2", endpoints: [{ endpoint_id: "w", method: "POST", body: { name: "x" } }] };
    const { didCensor } = censorSkillForPersistence(skill);
    expect(didCensor).toBe(false);
  });
});
