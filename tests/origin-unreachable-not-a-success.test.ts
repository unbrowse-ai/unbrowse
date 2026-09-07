/**
 * A dead origin is a MISS, not a success — and not a browser job either.
 *
 * Measured on the shipped CLI (v11.3.6) before this fix, against `swapi.dev`,
 * whose DNS record no longer exists:
 *
 *   trace.success  = true
 *   trace.status_code = 200        <- never received; nothing answered
 *   result.data    = "The Star Wars API - All the Star Wars data you've ever
 *                     wanted..."   <- swapi.INFO's marketing blurb
 *   result.synthetic_skill  = true
 *   result.exec_unsupported = true <- the code KNEW it was a preview
 *   exit 0
 *
 * So a caller asking for "get starwars person" was told, with a 200, that it had
 * succeeded — holding a different domain's homepage description. That is the
 * exact shape the bench contract calls a false success: transport success
 * laundered into task success, with contradictory terminal fields in one object.
 *
 * The contrast that isolates it: `api.spacexdata.com` returns a real HTTP 525,
 * and unbrowse reported success=false / status=525 correctly. Only the path
 * where NOTHING answered fabricated a 200.
 *
 * Two guards here, because fixing this naively breaks the browser floor:
 *   1. the dead-origin vocabulary has ONE definition, and it recognises the
 *      wrapped forms the orchestrator actually emits;
 *   2. a dead origin is excluded from the browser fallback, while a site that
 *      ANSWERS (403 / challenge / unnamed) still gets the browser — that floor
 *      is the whole point of the module and must not be collateral damage.
 */
import { describe, expect, test } from "bun:test";
import { isOriginUnreachableError } from "../src/values/origin-health.js";
import {
  shouldFallbackToBrowser,
  _resetBarrenPages,
} from "../src/orchestrator/browser-fallback.js";

const URL_ = "https://swapi.dev/api/people/1/";

const judged = (error: string) => ({
  trace: { success: false, error },
  result: { task_ok: false },
  timing: { browser_opened: false },
});

describe("dead-origin vocabulary (one shared definition)", () => {
  test("recognises the wrapped forms the orchestrator actually emits", () => {
    for (const e of [
      "origin_down (getaddrinfo ENOTFOUND swapi.dev)",
      "origin_down (fetch failed)",
      "ORIGIN_DNS",
      "probe network error (ECONNREFUSED)",
      "Error code 52",
      "ssl handshake failed",
    ]) {
      expect(isOriginUnreachableError(e)).toBe(true);
    }
  });

  test("does NOT swallow failures from a site that actually answered", () => {
    for (const e of [
      "",
      "response_shape_mismatch",
      "challenge",
      "datadome_blocked",
      "payment_required",
      "no_cached_match",
      "an_error_nobody_has_named_yet",
    ]) {
      expect(isOriginUnreachableError(e)).toBe(false);
    }
  });

  test("is total — never throws on a non-string", () => {
    for (const v of [undefined, null, 0, {}, []]) {
      expect(isOriginUnreachableError(v)).toBe(false);
    }
  });
});

describe("browser fallback vs a dead origin", () => {
  test("does not open a browser for an origin that never answered", () => {
    _resetBarrenPages();
    const d = shouldFallbackToBrowser(
      judged("origin_down (getaddrinfo ENOTFOUND swapi.dev)"),
      { url: URL_ },
      0,
      "get starwars person",
    );
    expect(d.escalate).toBe(false);
    expect(d.reason).toBe("origin_unreachable_browser_cannot_fix");
  });

  test("STILL opens a browser when the site answered — the floor is intact", () => {
    // Guards the over-broadening failure mode: if the new exclusion swallowed
    // ordinary misses, every one of these would stop escalating and the module's
    // reason for existing would be silently gone.
    for (const error of ["response_shape_mismatch", "challenge", "an_error_nobody_has_named_yet", ""]) {
      _resetBarrenPages();
      const d = shouldFallbackToBrowser(judged(error), { url: URL_ }, 0, "get starwars person");
      expect({ error, escalate: d.escalate }).toEqual({ error, escalate: true });
    }
  });
});
