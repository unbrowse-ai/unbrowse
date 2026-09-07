export type RealWorldCase = {
  id: string;
  domain: string;
  url: string;
  intent: string;
  auth: boolean;
  expected_fields: string[];
};

function isRootUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && !parsed.search;
  } catch {
    return false;
  }
}

function hasSearchSignal(url: string): boolean {
  try {
    const parsed = new URL(url);
    const keys = ["q", "query", "keywords", "term", "search"];
    return keys.some((key) => parsed.searchParams.has(key));
  } catch {
    return false;
  }
}

export function materializeRealWorldCase(entry: RealWorldCase): RealWorldCase | null {
  const lower = entry.intent.toLowerCase();
  const root = isRootUrl(entry.url);
  const searched = hasSearchSignal(entry.url);

  if (entry.domain === "x.com") {
    if (/\bsearch tweets\b/.test(lower) && (root || !searched)) {
      return { ...entry, url: "https://x.com/search?q=openai&src=typed_query&f=live" };
    }
    if (/\bget user profile\b/.test(lower) && root) {
      return { ...entry, url: "https://x.com/OpenAI" };
    }
    if (/\b(get )?(trending topics|topics|trends)\b/.test(lower) && root) {
      return { ...entry, url: "https://x.com/explore/tabs/trending" };
    }
    return entry;
  }

  if (entry.domain === "linkedin.com") {
    if (/\bsearch people\b/.test(lower) && (root || !searched)) {
      return { ...entry, url: "https://www.linkedin.com/search/results/people/?keywords=openai" };
    }
    if (/\bget company info\b/.test(lower) && root) {
      return { ...entry, url: "https://www.linkedin.com/company/openai/about/" };
    }
    return entry;
  }

  if (entry.domain === "reddit.com") {
    if (/\bsearch reddit\b/.test(lower) && (root || !searched)) {
      return { ...entry, url: "https://www.reddit.com/search/?q=openai" };
    }
    if (/\bget subreddit posts\b/.test(lower) && root) {
      return { ...entry, url: "https://www.reddit.com/r/programming/" };
    }
    if (/\bget post comments\b/.test(lower) && root) {
      return null;
    }
    return entry;
  }

  if (entry.domain === "mastodon.social") {
    if (/\bsearch posts\b/.test(lower)) return null;
    if (/\b(public timeline|get public timeline)\b/.test(lower)) return null;
    return entry;
  }

  if (entry.domain === "gitlab.com") {
    if (/\bsearch projects\b/.test(lower) && root) {
      return { ...entry, url: "https://gitlab.com/explore/projects?name=openai" };
    }
    if (/\bget project details\b/.test(lower) && root) {
      return { ...entry, url: "https://gitlab.com/gitlab-org/gitlab" };
    }
    return entry;
  }

  if (entry.domain === "npmjs.com") {
    if (/\bsearch packages\b/.test(lower) && root) {
      return { ...entry, url: "https://www.npmjs.com/search?q=openai" };
    }
    if (/\bget package info\b/.test(lower) && root) {
      return { ...entry, url: "https://www.npmjs.com/package/openai" };
    }
    return entry;
  }

  if (entry.domain === "pypi.org") {
    if (/\bsearch packages\b/.test(lower)) return null;
    if (/\bget package info\b/.test(lower) && root) {
      return { ...entry, url: "https://pypi.org/project/openai/" };
    }
    return entry;
  }

  if (entry.domain === "hub.docker.com") {
    if (/\bsearch images\b/.test(lower) && root) {
      return { ...entry, url: "https://hub.docker.com/search?q=nginx" };
    }
    if (/\bget image tags\b/.test(lower) && root) {
      return { ...entry, url: "https://hub.docker.com/r/library/nginx/tags" };
    }
    return entry;
  }

  if (entry.domain === "pinterest.com") {
    if (/\bsearch pins\b/.test(lower) && root) {
      return { ...entry, url: "https://www.pinterest.com/search/pins/?q=openai" };
    }
    return entry;
  }

  return entry;
}
