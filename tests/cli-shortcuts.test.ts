/**
 * Tests for the domain/task CLI shortcut system (Issue #213).
 *
 * Tests cover:
 * - Shortcut registry: site lookup, task lookup, aliases
 * - Dependency graph: buildDepsGraph correctness
 * - Execution planning: planExecution wave ordering
 * - Metadata: buildDepsMetadata output
 * - CLI dispatch: parseArgs + shortcut resolution
 */
import { describe, it, expect } from "bun:test";
import {
  findSitePack,
  findTask,
  allSitePacks,
  buildDepsGraph,
  planExecution,
  buildDepsMetadata,
} from "../src/cli/shortcuts.js";
import { parseArgs } from "../src/cli.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("findSitePack", () => {
  it("finds linkedin by name", () => {
    const pack = findSitePack("linkedin");
    expect(pack).toBeDefined();
    expect(pack!.site).toBe("linkedin");
    expect(pack!.domain).toBe("www.linkedin.com");
  });

  it("finds linkedin by alias 'li'", () => {
    const pack = findSitePack("li");
    expect(pack).toBeDefined();
    expect(pack!.site).toBe("linkedin");
  });

  it("finds github by name", () => {
    const pack = findSitePack("github");
    expect(pack).toBeDefined();
    expect(pack!.site).toBe("github");
  });

  it("finds github by alias 'gh'", () => {
    expect(findSitePack("gh")?.site).toBe("github");
  });

  it("returns undefined for unknown site", () => {
    expect(findSitePack("nonexistent")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(findSitePack("LinkedIn")?.site).toBe("linkedin");
    expect(findSitePack("GITHUB")?.site).toBe("github");
  });
});

describe("findTask", () => {
  const li = findSitePack("linkedin")!;

  it("finds feed task", () => {
    const task = findTask(li, "feed");
    expect(task).toBeDefined();
    expect(task!.intent).toBe("get feed posts");
    expect(task!.url).toBe("https://www.linkedin.com/feed/");
  });

  it("finds task by alias", () => {
    const task = findTask(li, "notifs");
    expect(task).toBeDefined();
    expect(task!.match[0]).toBe("notifications");
  });

  it("returns undefined for unknown task", () => {
    expect(findTask(li, "nonexistent")).toBeUndefined();
  });
});

describe("allSitePacks", () => {
  it("returns at least linkedin and github", () => {
    const packs = allSitePacks();
    const names = packs.map((p) => p.site);
    expect(names).toContain("linkedin");
    expect(names).toContain("github");
  });
});

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

describe("buildDepsGraph", () => {
  const li = findSitePack("linkedin")!;

  it("returns dependency graph for all tasks", () => {
    const graph = buildDepsGraph(li);
    expect(graph.login).toBeDefined();
    expect(graph.feed).toBeDefined();
    expect(graph.notifications).toBeDefined();
    expect(graph.messages).toBeDefined();
  });

  it("login has no requirements and enables feed/notifications/messages", () => {
    const graph = buildDepsGraph(li);
    expect(graph.login.requires).toEqual([]);
    expect(graph.login.enables).toContain("feed");
    expect(graph.login.enables).toContain("notifications");
    expect(graph.login.enables).toContain("messages");
  });

  it("feed requires login", () => {
    const graph = buildDepsGraph(li);
    expect(graph.feed.requires).toEqual(["login"]);
  });

  it("feed is parallel with notifications and messages", () => {
    const graph = buildDepsGraph(li);
    expect(graph.feed.parallel_with).toContain("notifications");
    expect(graph.feed.parallel_with).toContain("messages");
  });
});

// ---------------------------------------------------------------------------
// Execution planning
// ---------------------------------------------------------------------------

describe("planExecution", () => {
  const li = findSitePack("linkedin")!;

  it("single task with dependency produces 2 waves", () => {
    const waves = planExecution(li, ["feed"]);
    expect(waves.length).toBe(2);
    expect(waves[0].commands).toEqual(["unbrowse linkedin login"]);
    expect(waves[1].commands).toEqual(["unbrowse linkedin feed"]);
  });

  it("multiple independent tasks run in same wave", () => {
    const waves = planExecution(li, ["feed", "notifications"]);
    expect(waves.length).toBe(2);
    // Wave 1: login prerequisite
    expect(waves[0].commands).toEqual(["unbrowse linkedin login"]);
    // Wave 2: both feed and notifications in parallel
    expect(waves[1].commands).toContain("unbrowse linkedin feed");
    expect(waves[1].commands).toContain("unbrowse linkedin notifications");
  });

  it("login-only produces 1 wave", () => {
    const waves = planExecution(li, ["login"]);
    expect(waves.length).toBe(1);
    expect(waves[0].commands).toEqual(["unbrowse linkedin login"]);
  });

  it("github trending has no prerequisites (no login needed)", () => {
    const gh = findSitePack("github")!;
    const waves = planExecution(gh, ["trending"]);
    expect(waves.length).toBe(1);
    expect(waves[0].commands).toEqual(["unbrowse github trending"]);
  });

  it("github mixed auth/no-auth tasks produce correct waves", () => {
    const gh = findSitePack("github")!;
    const waves = planExecution(gh, ["trending", "notifications"]);
    // trending has no deps, notifications needs login
    // Wave 1: login (prereq for notifications)
    // Wave 2: trending + notifications in parallel
    expect(waves.length).toBe(2);
    expect(waves[0].commands).toEqual(["unbrowse github login"]);
    const wave2cmds = waves[1].commands;
    expect(wave2cmds).toContain("unbrowse github trending");
    expect(wave2cmds).toContain("unbrowse github notifications");
  });
});

// ---------------------------------------------------------------------------
// Deps metadata
// ---------------------------------------------------------------------------

describe("buildDepsMetadata", () => {
  const li = findSitePack("linkedin")!;

  it("login enables feed/notifications/messages", () => {
    const meta = buildDepsMetadata(li, "login");
    expect(meta.requires).toEqual([]);
    expect(meta.enables).toContain("feed");
    expect(meta.parallel_safe).toBe(false);
  });

  it("feed requires login and is parallel_safe", () => {
    const meta = buildDepsMetadata(li, "feed");
    expect(meta.requires).toEqual(["login"]);
    expect(meta.parallel_safe).toBe(true);
  });

  it("unknown task returns safe defaults", () => {
    const meta = buildDepsMetadata(li, "nonexistent");
    expect(meta.requires).toEqual([]);
    expect(meta.enables).toEqual([]);
    expect(meta.parallel_safe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI arg parsing + shortcut detection
// ---------------------------------------------------------------------------

describe("parseArgs shortcut detection", () => {
  it("parses 'linkedin feed --pretty' correctly", () => {
    const { command, args, flags } = parseArgs(["node", "cli", "linkedin", "feed", "--pretty"]);
    expect(command).toBe("linkedin");
    expect(args).toEqual(["feed"]);
    expect(flags.pretty).toBe(true);
  });

  it("parses 'linkedin help --deps' correctly", () => {
    const { command, args, flags } = parseArgs(["node", "cli", "linkedin", "help", "--deps"]);
    expect(command).toBe("linkedin");
    expect(args).toEqual(["help"]);
    expect(flags.deps).toBe(true);
  });

  it("parses 'linkedin help --plan feed,notifications' correctly", () => {
    const { command, args, flags } = parseArgs(["node", "cli", "linkedin", "help", "--plan", "feed,notifications"]);
    expect(command).toBe("linkedin");
    expect(args).toEqual(["help"]);
    expect(flags.plan).toBe("feed,notifications");
  });

  it("parses 'linkedin --batch feed,notifications' correctly", () => {
    const { command, args, flags } = parseArgs(["node", "cli", "linkedin", "--batch", "feed,notifications"]);
    expect(command).toBe("linkedin");
    expect(flags.batch).toBe("feed,notifications");
  });

  it("raw commands still parse normally", () => {
    const { command, args, flags } = parseArgs(["node", "cli", "resolve", "--intent", "get feed"]);
    expect(command).toBe("resolve");
    expect(flags.intent).toBe("get feed");
  });
});
