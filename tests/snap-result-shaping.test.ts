// Loop 13: in-thread MCP dogfooding of jup.ag (Cloudflare-protected; the
// headless tab wedged). unbrowse_eval honestly returned
// {error:"recoverable_browse_failure", message:"The operation was aborted.",
// recoverable:true} (the 502 body sendBrowseSessionError produces). But
// unbrowse_snap returned a CLEAN "Current browse snapshot." with an all-zeros
// {root_aria:"",current_url:"",interactive_count:0,...} and no
// session_id/warning/next_step. Root, confirmed entirely from code: the
// backend /v1/browse/snap returns 502 {error:"recoverable_browse_failure",
// recoverable:true}; mcp api() returns any application/json body regardless of
// status; the snap handler then did raw.snapshot ?? "" -> applySnapDetailLevel
// -> successResult("Current browse snapshot."), discarding raw.error /
// raw.recoverable / raw.message. A genuine snap response ALWAYS carries
// `snapshot` as a string (even loop-6's empty case: snapshot:""); a backend
// error envelope has `error` and no string `snapshot`. The shaper must surface
// the error honestly (like every other browse handler, which passes the raw
// body through so error/recoverable stay visible) instead of fabricating a
// fake-empty successful snapshot that hides a wedged / recoverable failure.
import { describe, expect, it } from "bun:test";
import { shapeSnapResult } from "../src/api/browse-snap-detail-levels.js";

describe("shapeSnapResult: a backend error envelope is surfaced, not fabricated into an empty snapshot", () => {
  it("surfaces a recoverable_browse_failure instead of a fake 'Current browse snapshot.'", () => {
    // The exact 502 body sendBrowseSessionError emits for a wedged tab.
    const raw = {
      error: "recoverable_browse_failure",
      message: "The operation was aborted.",
      recoverable: true,
    };
    const shaped = shapeSnapResult(raw, "minimal");
    // Must NOT claim a snapshot.
    expect(shaped.summary).not.toBe("Current browse snapshot.");
    // The recoverable failure must reach the agent (same fields the backend
    // produced and every other browse handler passes through).
    expect((shaped.value as Record<string, unknown>).error).toBe("recoverable_browse_failure");
    expect((shaped.value as Record<string, unknown>).recoverable).toBe(true);
    expect((shaped.value as Record<string, unknown>).message).toBe("The operation was aborted.");
    // Must NOT have been reshaped into a fabricated all-zeros snapshot.
    expect((shaped.value as Record<string, unknown>).root_aria).toBeUndefined();
    expect((shaped.value as Record<string, unknown>).interactive_count).toBeUndefined();
  });

  it("also surfaces a BrowseSessionError-style envelope (error code, no snapshot)", () => {
    const raw = { error: "no_browse_session", latest_session_id: "abc", next_action: { title: "Open a browser session" } };
    const shaped = shapeSnapResult(raw, "minimal");
    expect(shaped.summary).not.toBe("Current browse snapshot.");
    expect((shaped.value as Record<string, unknown>).error).toBe("no_browse_session");
  });

  it("REGRESSION: a real snapshot string is still shaped normally", () => {
    const raw = {
      snapshot: '[e0] RootWebArea "Example Domain" state="focused"\n  [e1] heading "Example Domain"',
      current_url: "https://example.com/",
      page_title: "Example Domain",
      session_id: "s1",
      tab_id: "t1",
    };
    const shaped = shapeSnapResult(raw, "minimal");
    expect(shaped.summary).toBe("Current browse snapshot.");
    const v = shaped.value as Record<string, unknown>;
    expect(v.detail_level).toBe("minimal");
    expect(String(v.root_aria)).toContain("Example Domain");
    expect(v.current_url).toBe("https://example.com/");
    expect(v.session_id).toBe("s1");
    expect(v.tab_id).toBe("t1");
  });

  it("REGRESSION: loop-6 empty-but-valid snapshot (snapshot:'') still preserves warning + next_step", () => {
    const raw = {
      snapshot: "",
      current_url: "https://en.wikipedia.org/wiki/X",
      page_title: "",
      session_id: "s2",
      tab_id: "t2",
      warning: "empty_snapshot",
      next_step: "Snapshot was empty; retry after 500-1000ms or call unbrowse_screenshot.",
    };
    const shaped = shapeSnapResult(raw, "minimal");
    expect(shaped.summary).toBe("Current browse snapshot.");
    const v = shaped.value as Record<string, unknown>;
    expect(v.warning).toBe("empty_snapshot");
    expect(v.next_step).toBe("Snapshot was empty; retry after 500-1000ms or call unbrowse_screenshot.");
    expect(v.session_id).toBe("s2");
  });
});
