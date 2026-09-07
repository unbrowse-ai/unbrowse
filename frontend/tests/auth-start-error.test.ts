// frontend/tests/auth-start-error.test.ts
// Witnesses the sign-in transient-error fix: the status the user saw (HTTP 410)
// must classify as "transient" → friendly retryable message, never a dead-end raw status.
import { describe, expect, test } from "bun:test";
import {
  classifyAuthStartStatus,
  TRANSIENT_AUTH_MESSAGE,
  INVALID_EMAIL_MESSAGE,
} from "../src/lib/auth-errors";

describe("classifyAuthStartStatus", () => {
  test("the screenshotted 410 is transient, not a dead end", () => {
    expect(classifyAuthStartStatus(410)).toBe("transient");
  });

  test("the whole transient family maps to transient", () => {
    for (const s of [408, 410, 425, 429, 500, 502, 503, 504]) {
      expect(classifyAuthStartStatus(s)).toBe("transient");
    }
  });

  test("400 is an invalid-email case, not transient", () => {
    expect(classifyAuthStartStatus(400)).toBe("invalid");
  });

  test("2xx is ok (proceed to token)", () => {
    expect(classifyAuthStartStatus(200)).toBe("ok");
    expect(classifyAuthStartStatus(204)).toBe("ok");
  });

  test("other non-ok statuses fall through to 'other' (raw/backend error)", () => {
    expect(classifyAuthStartStatus(401)).toBe("other");
    expect(classifyAuthStartStatus(403)).toBe("other");
    expect(classifyAuthStartStatus(404)).toBe("other");
  });

  test("the friendly messages are non-empty and not a raw status code", () => {
    expect(TRANSIENT_AUTH_MESSAGE.length).toBeGreaterThan(0);
    expect(TRANSIENT_AUTH_MESSAGE).not.toMatch(/HTTP \d|410/);
    expect(INVALID_EMAIL_MESSAGE.length).toBeGreaterThan(0);
  });
});
