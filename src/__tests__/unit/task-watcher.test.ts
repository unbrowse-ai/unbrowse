/**
 * Unit tests for task-watcher.ts
 *
 * Tests the TaskWatcher class:
 *   - parseIntent() — domain/action extraction from prompts
 *   - detectFailure() — error classification
 *   - canWeHelp() — resolvability check
 *   - getFailureHistory() / clearHistory() — state management
 *   - getCurrentIntent() — intent retrieval
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { TaskWatcher } from "../../task-watcher.js";

let watcher: TaskWatcher;

beforeEach(() => {
  watcher = new TaskWatcher();
});

// ── parseIntent: domain extraction ───────────────────────────────────────────

describe("parseIntent domain extraction", () => {
  it("detects twitter from 'tweet'", () => {
    const intent = watcher.parseIntent("Post a tweet about AI");
    expect(intent.domain).toBe("twitter");
  });

  it("detects github from 'pull request'", () => {
    const intent = watcher.parseIntent("Create a pull request for the fix");
    expect(intent.domain).toBe("github");
  });

  it("detects slack from 'channel'", () => {
    const intent = watcher.parseIntent("Send a message to the #general channel");
    expect(intent.domain).toBe("slack");
  });

  it("detects linear from 'ticket'", () => {
    const intent = watcher.parseIntent("Create a ticket for the bug");
    expect(intent.domain).toBe("linear");
  });

  it("detects notion from keyword", () => {
    const intent = watcher.parseIntent("Update the Notion page");
    expect(intent.domain).toBe("notion");
  });

  it("detects gmail from 'email'", () => {
    const intent = watcher.parseIntent("Send an email to John");
    expect(intent.domain).toBe("gmail");
  });

  it("detects spotify from 'playlist'", () => {
    const intent = watcher.parseIntent("Create a new playlist");
    expect(intent.domain).toBe("spotify");
  });

  it("detects domain from URL", () => {
    const intent = watcher.parseIntent("Fetch data from https://api.example.com/users");
    expect(intent.domain).toBe("api");
  });

  it("returns null domain for unrecognized prompt", () => {
    const intent = watcher.parseIntent("What is the weather today?");
    expect(intent.domain).toBeNull();
  });
});

// ── parseIntent: action extraction ───────────────────────────────────────────

describe("parseIntent action extraction", () => {
  it("detects create action from 'post'", () => {
    const intent = watcher.parseIntent("Post a tweet about AI");
    expect(intent.action).toBe("create");
  });

  it("detects read action from 'fetch'", () => {
    const intent = watcher.parseIntent("Fetch my github repos");
    expect(intent.action).toBe("read");
  });

  it("detects update action from 'edit'", () => {
    const intent = watcher.parseIntent("Edit the notion page");
    expect(intent.action).toBe("update");
  });

  it("detects delete action from 'remove'", () => {
    const intent = watcher.parseIntent("Remove the old repo");
    expect(intent.action).toBe("delete");
  });

  it("detects auth action from 'login'", () => {
    const intent = watcher.parseIntent("Login to twitter");
    expect(intent.action).toBe("auth");
  });

  it("returns null action for unrecognized verbs", () => {
    const intent = watcher.parseIntent("weather forecast");
    expect(intent.action).toBeNull();
  });
});

// ── parseIntent: requirements ────────────────────────────────────────────────

describe("parseIntent requirements", () => {
  it("requires auth for write actions", () => {
    const intent = watcher.parseIntent("Post a tweet about AI");
    expect(intent.requirements).toContain("auth");
  });

  it("requires auth for private data", () => {
    const intent = watcher.parseIntent("Show my github repos");
    expect(intent.requirements).toContain("auth");
  });

  it("requires api-access when domain is detected", () => {
    const intent = watcher.parseIntent("Get github repos");
    expect(intent.requirements).toContain("api-access");
  });

  it("deduplicates requirements", () => {
    const intent = watcher.parseIntent("Post to my personal twitter account");
    // Both "post" (write action) and "my personal" (private) trigger auth
    const authCount = intent.requirements.filter(r => r === "auth").length;
    expect(authCount).toBe(1);
  });
});

// ── parseIntent: confidence ──────────────────────────────────────────────────

describe("parseIntent confidence", () => {
  it("has low confidence with no domain or action", () => {
    const intent = watcher.parseIntent("weather forecast");
    expect(intent.confidence).toBe(0.3);
  });

  it("has medium confidence with domain only", () => {
    const intent = watcher.parseIntent("something about github");
    expect(intent.confidence).toBeCloseTo(0.65, 10);
  });

  it("has medium confidence with action only", () => {
    const intent = watcher.parseIntent("delete that thing");
    expect(intent.confidence).toBeCloseTo(0.55, 10);
  });

  it("has high confidence with both domain and action", () => {
    const intent = watcher.parseIntent("create a github repo");
    expect(intent.confidence).toBeCloseTo(0.9, 10);
  });
});

// ── parseIntent: raw prompt ──────────────────────────────────────────────────

describe("parseIntent rawPrompt", () => {
  it("preserves the original prompt", () => {
    const prompt = "Fetch my twitter feed please";
    const intent = watcher.parseIntent(prompt);
    expect(intent.rawPrompt).toBe(prompt);
  });
});

// ── getCurrentIntent ─────────────────────────────────────────────────────────

describe("getCurrentIntent", () => {
  it("returns null before any parse", () => {
    expect(watcher.getCurrentIntent()).toBeNull();
  });

  it("returns last parsed intent", () => {
    watcher.parseIntent("Get github repos");
    const intent = watcher.getCurrentIntent();
    expect(intent).not.toBeNull();
    expect(intent!.domain).toBe("github");
  });

  it("updates on subsequent parses", () => {
    watcher.parseIntent("Get github repos");
    watcher.parseIntent("Post a tweet");
    const intent = watcher.getCurrentIntent();
    expect(intent!.domain).toBe("twitter");
  });
});

// ── detectFailure: error classification ──────────────────────────────────────

describe("detectFailure error classification", () => {
  it("classifies 401 as auth error", () => {
    const failure = watcher.detectFailure("api_call", null, "HTTP 401 Unauthorized");
    expect(failure).not.toBeNull();
    expect(failure!.errorType).toBe("auth");
    expect(failure!.canResolve).toBe(true);
  });

  it("classifies 403 as auth error", () => {
    const failure = watcher.detectFailure("fetch", null, "403 Forbidden");
    expect(failure!.errorType).toBe("auth");
  });

  it("classifies 429 as rate limit", () => {
    const failure = watcher.detectFailure("api", null, "429 Too Many Requests");
    expect(failure!.errorType).toBe("rate_limit");
    expect(failure!.canResolve).toBe(true);
  });

  it("classifies 'rate limit exceeded' as rate limit", () => {
    const failure = watcher.detectFailure("api", null, "Rate limit exceeded. Try again later.");
    expect(failure!.errorType).toBe("rate_limit");
  });

  it("classifies captcha as blocked", () => {
    const failure = watcher.detectFailure("fetch", null, "Captcha required");
    expect(failure!.errorType).toBe("blocked");
    expect(failure!.canResolve).toBe(true);
  });

  it("classifies bot detection as blocked", () => {
    const failure = watcher.detectFailure("browser", null, "Bot detection triggered");
    expect(failure!.errorType).toBe("blocked");
  });

  it("classifies 404 as not_found", () => {
    const failure = watcher.detectFailure("api", null, "404 Not Found");
    expect(failure!.errorType).toBe("not_found");
    expect(failure!.canResolve).toBe(true);
  });

  it("classifies unknown errors", () => {
    const failure = watcher.detectFailure("tool", null, "Something went wrong");
    expect(failure!.errorType).toBe("unknown");
    expect(failure!.canResolve).toBe(false);
  });

  it("returns null when no error", () => {
    const failure = watcher.detectFailure("tool", { success: true });
    expect(failure).toBeNull();
  });

  it("provides suggested actions for resolvable errors", () => {
    const auth = watcher.detectFailure("api", null, "401 Unauthorized");
    expect(auth!.suggestedAction).toBeDefined();

    const rateLimit = watcher.detectFailure("api", null, "Rate limit");
    expect(rateLimit!.suggestedAction).toBeDefined();
  });
});

// ── detectFailure: soft failures ─────────────────────────────────────────────

describe("detectFailure soft failures", () => {
  it("detects auth required from response status 401", () => {
    const failure = watcher.detectFailure("api", { status: 401, body: "unauthorized" });
    expect(failure).not.toBeNull();
    expect(failure!.errorType).toBe("auth");
  });

  it("detects rate limit from response content", () => {
    const failure = watcher.detectFailure("api", { message: "rate limit exceeded" });
    expect(failure).not.toBeNull();
    expect(failure!.errorType).toBe("rate_limit");
  });

  it("returns null for successful results", () => {
    const failure = watcher.detectFailure("api", { status: 200, data: [1, 2, 3] });
    expect(failure).toBeNull();
  });

  it("returns null for null result without error", () => {
    const failure = watcher.detectFailure("tool", null);
    expect(failure).toBeNull();
  });

  it("returns null for primitive results", () => {
    const failure = watcher.detectFailure("tool", "success");
    expect(failure).toBeNull();
  });
});

// ── canWeHelp ────────────────────────────────────────────────────────────────

describe("canWeHelp", () => {
  it("returns true for auth errors", () => {
    const failure = watcher.detectFailure("api", null, "401");
    expect(watcher.canWeHelp(failure!)).toBe(true);
  });

  it("returns false for unknown errors", () => {
    const failure = watcher.detectFailure("api", null, "something random");
    expect(watcher.canWeHelp(failure!)).toBe(false);
  });
});

// ── failure history ──────────────────────────────────────────────────────────

describe("failure history", () => {
  it("starts empty", () => {
    expect(watcher.getFailureHistory()).toEqual([]);
  });

  it("accumulates failures", () => {
    watcher.detectFailure("api1", null, "401");
    watcher.detectFailure("api2", null, "429");

    const history = watcher.getFailureHistory();
    expect(history).toHaveLength(2);
    expect(history[0].toolName).toBe("api1");
    expect(history[1].toolName).toBe("api2");
  });

  it("includes soft failures in history", () => {
    watcher.detectFailure("api", { status: 401 });

    expect(watcher.getFailureHistory()).toHaveLength(1);
  });

  it("does not add null failures to history", () => {
    watcher.detectFailure("api", { status: 200 });

    expect(watcher.getFailureHistory()).toHaveLength(0);
  });
});

// ── clearHistory ─────────────────────────────────────────────────────────────

describe("clearHistory", () => {
  it("clears failure history and current intent", () => {
    watcher.parseIntent("Get github repos");
    watcher.detectFailure("api", null, "401");

    watcher.clearHistory();

    expect(watcher.getFailureHistory()).toEqual([]);
    expect(watcher.getCurrentIntent()).toBeNull();
  });
});
