/**
 * Domain/task shortcut registry.
 *
 * Each site pack defines:
 * - aliases for CLI matching
 * - canonical domain and login URL
 * - task matchers with intent, URL, and dependency metadata
 *
 * The shortcut system compiles `unbrowse <site> <task>` into the existing
 * resolve/login API without requiring backend changes.
 */

export interface TaskDef {
  /** User-facing task names (first is canonical) */
  match: string[];
  /** What this task does — maps to resolve --intent */
  intent: string;
  /** Target URL for the task */
  url: string;
  /** Tasks/states that must complete before this one */
  requires: string[];
  /** Tasks that become available after this one succeeds */
  enables: string[];
  /** Tasks safe to run concurrently with this one (post-dependencies) */
  parallel_with: string[];
  /** Whether this task is safe to run concurrently (default true for reads) */
  parallel_safe: boolean;
  /** Whether this task needs authentication */
  needs_auth: boolean;
  /** Short description for help output */
  description: string;
}

export interface SitePack {
  /** Primary site name */
  site: string;
  /** Alternative names */
  aliases: string[];
  /** Canonical domain */
  domain: string;
  /** Login URL for auth flow */
  login_url: string;
  /** Available tasks */
  tasks: TaskDef[];
  /** Short site description */
  description: string;
}

// ---------------------------------------------------------------------------
// Site packs
// ---------------------------------------------------------------------------

const linkedin: SitePack = {
  site: "linkedin",
  aliases: ["linkedin", "li"],
  domain: "www.linkedin.com",
  login_url: "https://www.linkedin.com/login",
  description: "LinkedIn — professional network",
  tasks: [
    {
      match: ["login"],
      intent: "login",
      url: "https://www.linkedin.com/login",
      requires: [],
      enables: ["feed", "notifications", "messages"],
      parallel_with: [],
      parallel_safe: false,
      needs_auth: false,
      description: "Authenticate with LinkedIn",
    },
    {
      match: ["feed"],
      intent: "get feed posts",
      url: "https://www.linkedin.com/feed/",
      requires: ["login"],
      enables: [],
      parallel_with: ["notifications", "messages"],
      parallel_safe: true,
      needs_auth: true,
      description: "Fetch your LinkedIn feed",
    },
    {
      match: ["notifications", "notifs"],
      intent: "get notifications",
      url: "https://www.linkedin.com/notifications/",
      requires: ["login"],
      enables: [],
      parallel_with: ["feed", "messages"],
      parallel_safe: true,
      needs_auth: true,
      description: "Fetch your notifications",
    },
    {
      match: ["messages", "msgs"],
      intent: "get messages",
      url: "https://www.linkedin.com/messaging/",
      requires: ["login"],
      enables: [],
      parallel_with: ["feed", "notifications"],
      parallel_safe: true,
      needs_auth: true,
      description: "Fetch your messages",
    },
  ],
};

const github: SitePack = {
  site: "github",
  aliases: ["github", "gh"],
  domain: "github.com",
  login_url: "https://github.com/login",
  description: "GitHub — code hosting",
  tasks: [
    {
      match: ["login"],
      intent: "login",
      url: "https://github.com/login",
      requires: [],
      enables: ["trending", "notifications", "repos"],
      parallel_with: [],
      parallel_safe: false,
      needs_auth: false,
      description: "Authenticate with GitHub",
    },
    {
      match: ["trending"],
      intent: "get trending repositories",
      url: "https://github.com/trending",
      requires: [],
      enables: [],
      parallel_with: ["notifications", "repos"],
      parallel_safe: true,
      needs_auth: false,
      description: "Fetch trending repositories (no auth needed)",
    },
    {
      match: ["notifications", "notifs"],
      intent: "get notifications",
      url: "https://github.com/notifications",
      requires: ["login"],
      enables: [],
      parallel_with: ["trending", "repos"],
      parallel_safe: true,
      needs_auth: true,
      description: "Fetch your notifications",
    },
    {
      match: ["repos"],
      intent: "get repositories",
      url: "https://github.com",
      requires: ["login"],
      enables: [],
      parallel_with: ["trending", "notifications"],
      parallel_safe: true,
      needs_auth: true,
      description: "Fetch your repositories",
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const SITE_PACKS: SitePack[] = [linkedin, github];

/** Look up a site pack by name or alias. */
export function findSitePack(name: string): SitePack | undefined {
  const lower = name.toLowerCase();
  return SITE_PACKS.find((p) => p.aliases.includes(lower));
}

/** Look up a task within a site pack. */
export function findTask(pack: SitePack, taskName: string): TaskDef | undefined {
  const lower = taskName.toLowerCase();
  return pack.tasks.find((t) => t.match.includes(lower));
}

/** Get all registered site packs. */
export function allSitePacks(): readonly SitePack[] {
  return SITE_PACKS;
}

// ---------------------------------------------------------------------------
// Dependency graph helpers
// ---------------------------------------------------------------------------

/** Build dependency graph for a site's tasks. */
export function buildDepsGraph(pack: SitePack): Record<string, { requires: string[]; enables: string[]; parallel_with: string[] }> {
  const graph: Record<string, { requires: string[]; enables: string[]; parallel_with: string[] }> = {};
  for (const task of pack.tasks) {
    graph[task.match[0]] = {
      requires: task.requires,
      enables: task.enables,
      parallel_with: task.parallel_with,
    };
  }
  return graph;
}

/** Generate an execution plan (waves) for a set of tasks. */
export function planExecution(pack: SitePack, taskNames: string[]): { wave: number; commands: string[]; reason: string }[] {
  const waves: { wave: number; commands: string[]; reason: string }[] = [];
  const resolved = new Set<string>();
  const remaining = new Set(taskNames.map((n) => n.toLowerCase()));

  // Collect all prerequisites
  const allPrereqs = new Set<string>();
  for (const name of remaining) {
    const task = findTask(pack, name);
    if (task) {
      for (const req of task.requires) {
        if (!remaining.has(req)) allPrereqs.add(req);
      }
    }
  }

  // Wave 0: prerequisites not in the requested set
  if (allPrereqs.size > 0) {
    waves.push({
      wave: 1,
      commands: [...allPrereqs].map((t) => `unbrowse ${pack.site} ${t}`),
      reason: "prerequisite",
    });
    for (const p of allPrereqs) resolved.add(p);
  }

  // Wave N: group remaining tasks by whether all deps are resolved
  let waveNum = waves.length + 1;
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const name of remaining) {
      const task = findTask(pack, name);
      if (!task) { remaining.delete(name); continue; }
      const depsOk = task.requires.every((r) => resolved.has(r));
      if (depsOk) ready.push(name);
    }
    if (ready.length === 0) {
      // Circular or unresolvable — push everything remaining
      waves.push({
        wave: waveNum,
        commands: [...remaining].map((t) => `unbrowse ${pack.site} ${t}`),
        reason: "unresolvable dependencies",
      });
      break;
    }
    waves.push({
      wave: waveNum,
      commands: ready.map((t) => `unbrowse ${pack.site} ${t}`),
      reason: ready.length > 1 ? "independent after prerequisites" : "sequential",
    });
    for (const r of ready) { resolved.add(r); remaining.delete(r); }
    waveNum++;
  }

  return waves;
}

/** Build _deps metadata for a command's JSON output. */
export function buildDepsMetadata(pack: SitePack, taskName: string): {
  requires: string[];
  enables: string[];
  parallel_safe: boolean;
  session_id?: string;
} {
  const task = findTask(pack, taskName);
  if (!task) return { requires: [], enables: [], parallel_safe: true };
  return {
    requires: task.requires,
    enables: task.enables,
    parallel_safe: task.parallel_safe,
  };
}
