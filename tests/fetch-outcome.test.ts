import { describe, expect, test } from "bun:test";
import { fetchOutcome } from "../src/cli.js";

// `unbrowse fetch` must surface failure in its exit code. Before fetchOutcome,
// a 404 exited 0 (empty stdout) and a DNS/network failure exited 0 (printed
// "null") — an agent or shell script could not distinguish success from failure
// on the primary content tool.
describe("fetchOutcome — fetch success/failure for exit code", () => {
  test("2xx with a body is success", () => {
    expect(fetchOutcome(200, '{"ok":true}')).toEqual({ ok: true });
    expect(fetchOutcome(204, "")).toEqual({ ok: true });
  });
  test("HTTP >= 400 is a failure (curl --fail semantics)", () => {
    expect(fetchOutcome(404, "").ok).toBe(false);
    expect(fetchOutcome(404, "").reason).toBe("HTTP 404");
    expect(fetchOutcome(500, "Internal Error").ok).toBe(false);
  });
  test("no usable status + no body (DNS/network failure) is a failure", () => {
    expect(fetchOutcome("?", null).ok).toBe(false);
    expect(fetchOutcome(undefined, "").ok).toBe(false);
    expect(fetchOutcome(0, null).ok).toBe(false);
  });
  test("no status but a present body (rare body-sniff path) is success", () => {
    expect(fetchOutcome("?", "some content").ok).toBe(true);
  });
});
