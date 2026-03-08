function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getPath(obj: unknown, path: string): unknown {
  if (!isRecord(obj)) return undefined;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAnyPath(obj: unknown, paths: string[]): boolean {
  return paths.some((path) => {
    const value = getPath(obj, path);
    return hasNonEmptyString(value) || typeof value === "number";
  });
}

function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value
      .filter((item): item is string => hasNonEmptyString(item))
      .map((item) => String(item).trim());
    return out.length > 0 ? out : undefined;
  }
  if (hasNonEmptyString(value)) return [String(value).trim()];
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (hasNonEmptyString(value)) return String(value).trim();
  }
  return undefined;
}

function normalizePackageSearchResults(data: unknown): Record<string, unknown>[] {
  const sourceRows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.objects)
      ? data.objects
      : isRecord(data) && Array.isArray(data.packages)
        ? data.packages
        : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const pkg = isRecord(item.package) ? item.package : item;
    const name = getPath(pkg, "name");
    if (!hasNonEmptyString(name) || seen.has(String(name))) continue;
    const version = firstNonEmptyString(getPath(pkg, "version"));
    const description = firstNonEmptyString(getPath(pkg, "description"), getPath(pkg, "summary"));
    const url =
      firstNonEmptyString(
        getPath(pkg, "links.npm"),
        getPath(pkg, "project_url"),
        getPath(pkg, "package_url"),
        getPath(pkg, "url"),
      ) ?? `https://www.npmjs.com/package/${encodeURIComponent(String(name))}`;
    const keywords = toStringArray(getPath(pkg, "keywords"));
    rows.push({
      name: String(name),
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      ...(keywords ? { keywords } : {}),
      url,
    });
    seen.add(String(name));
  }

  return rows;
}

function normalizeNpmPackageInfo(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data) || !hasNonEmptyString(data.name)) return null;
  const distTags = isRecord(data["dist-tags"]) ? data["dist-tags"] : undefined;
  const versions = isRecord(data.versions) ? data.versions : undefined;
  const latestVersion = firstNonEmptyString(distTags?.latest, data.version);
  const latestRecord =
    latestVersion && versions && isRecord(versions[latestVersion])
      ? versions[latestVersion]
      : undefined;
  const description = firstNonEmptyString(
    getPath(latestRecord, "description"),
    getPath(data, "description"),
  );
  const homepage = firstNonEmptyString(
    getPath(latestRecord, "homepage"),
    getPath(data, "homepage"),
    getPath(latestRecord, "repository.url"),
    getPath(data, "repository.url"),
  );
  const dependencies = isRecord(getPath(latestRecord, "dependencies"))
    ? Object.keys(getPath(latestRecord, "dependencies") as Record<string, unknown>)
    : undefined;
  const keywords = toStringArray(getPath(latestRecord, "keywords") ?? getPath(data, "keywords"));
  const author = firstNonEmptyString(
    getPath(latestRecord, "author.name"),
    getPath(latestRecord, "author"),
    getPath(data, "author.name"),
    getPath(data, "author"),
  );

  return {
    name: String(data.name),
    ...(latestVersion ? { version: latestVersion } : {}),
    ...(description ? { description } : {}),
    ...(keywords ? { keywords } : {}),
    ...(dependencies && dependencies.length > 0 ? { dependencies } : {}),
    ...(author ? { author } : {}),
    url: homepage ?? `https://www.npmjs.com/package/${encodeURIComponent(String(data.name))}`,
  };
}

function normalizePyPIPackageInfo(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  const info = isRecord(data.info) ? data.info : data;
  const name = getPath(info, "name");
  if (!hasNonEmptyString(name)) return null;
  const summary = firstNonEmptyString(getPath(info, "summary"), getPath(info, "description"));
  const version = firstNonEmptyString(getPath(info, "version"));
  const author = firstNonEmptyString(getPath(info, "author"));
  const requiresDist = Array.isArray(getPath(info, "requires_dist"))
    ? (getPath(info, "requires_dist") as unknown[]).filter((item) => hasNonEmptyString(item)).map(String)
    : undefined;
  const url = firstNonEmptyString(
    getPath(info, "project_url"),
    getPath(info, "package_url"),
    getPath(info, "home_page"),
    getPath(info, "project_urls.Homepage"),
  );

  return {
    name: String(name),
    ...(version ? { version } : {}),
    ...(summary ? { summary, description: summary } : {}),
    ...(author ? { author } : {}),
    ...(requiresDist && requiresDist.length > 0 ? { requires_dist: requiresDist } : {}),
    ...(url ? { url } : {}),
  };
}

function normalizeDockerImageSearchResults(data: unknown): Record<string, unknown>[] {
  const sourceRows = isRecord(data) && Array.isArray(data.results)
    ? data.results
    : Array.isArray(data)
      ? data
      : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const repoName = firstNonEmptyString(getPath(item, "repo_name"), getPath(item, "name"));
    if (!repoName || seen.has(repoName)) continue;
    rows.push({
      repo_name: repoName,
      ...(firstNonEmptyString(getPath(item, "short_description"), getPath(item, "description")) ? {
        short_description: firstNonEmptyString(getPath(item, "short_description"), getPath(item, "description")),
      } : {}),
      ...(typeof getPath(item, "star_count") === "number" ? { star_count: getPath(item, "star_count") } : {}),
      ...(typeof getPath(item, "pull_count") === "number" ? { pull_count: getPath(item, "pull_count") } : {}),
      url: `https://hub.docker.com/r/${repoName}`,
    });
    seen.add(repoName);
  }

  return rows;
}

function normalizeDockerTagResults(data: unknown): Record<string, unknown>[] {
  const sourceRows = isRecord(data) && Array.isArray(data.results)
    ? data.results
    : Array.isArray(data)
      ? data
      : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const name = firstNonEmptyString(getPath(item, "name"), getPath(item, "tag"));
    if (!name || seen.has(name)) continue;
    rows.push({
      name,
      ...(typeof getPath(item, "full_size") === "number" ? { full_size: getPath(item, "full_size") } : {}),
      ...(firstNonEmptyString(getPath(item, "last_updated"), getPath(item, "updated_at")) ? {
        last_updated: firstNonEmptyString(getPath(item, "last_updated"), getPath(item, "updated_at")),
      } : {}),
      ...(firstNonEmptyString(getPath(item, "digest")) ? { digest: firstNonEmptyString(getPath(item, "digest")) } : {}),
    });
    seen.add(name);
  }

  return rows;
}

function collectNestedObjects(value: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNestedObjects(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  for (const child of Object.values(value)) collectNestedObjects(child, visit);
}

function normalizeXTweets(data: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  collectNestedObjects(data, (obj) => {
    const result = getPath(obj, "tweet_results.result");
    if (!isRecord(result)) return;
    const restId = getPath(result, "rest_id");
    const text = getPath(result, "legacy.full_text");
    const screenName = getPath(result, "core.user_results.result.core.screen_name")
      ?? getPath(result, "core.user_results.result.legacy.screen_name");
    if (!hasNonEmptyString(restId) || !hasNonEmptyString(text) || !hasNonEmptyString(screenName)) return;
    if (seen.has(String(restId))) return;
    rows.push({
      id: String(restId),
      username: String(screenName),
      text: String(text),
      url: `https://x.com/${encodeURIComponent(String(screenName))}/status/${encodeURIComponent(String(restId))}`,
    });
    seen.add(String(restId));
  });
  return rows;
}

function normalizeXUsers(data: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  collectNestedObjects(data, (obj) => {
    const result = getPath(obj, "user_results.result");
    const target = isRecord(result) ? result : obj;
    const screenName = getPath(target, "core.screen_name") ?? getPath(target, "legacy.screen_name");
    const name = getPath(target, "core.name") ?? getPath(target, "legacy.name");
    const description = getPath(target, "legacy.description");
    const followers = getPath(target, "legacy.followers_count");
    if (!hasNonEmptyString(screenName) || !hasNonEmptyString(name)) return;
    if (seen.has(String(screenName))) return;
    rows.push({
      username: String(screenName),
      public_identifier: String(screenName),
      name: String(name),
      ...(hasNonEmptyString(description) ? { description: String(description) } : {}),
      ...(typeof followers === "number" ? { followers_count: followers } : {}),
      url: `https://x.com/${encodeURIComponent(String(screenName))}`,
    });
    seen.add(String(screenName));
  });
  return rows;
}

function normalizeGenericPeopleRows(data: unknown): Record<string, unknown>[] {
  const sourceRows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.results)
      ? data.results
      : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    if (
      hasAnyPath(item, ["full_name", "repository.name", "path_with_namespace", "stargazers_count", "stars", "star_count", "forks_count", "version", "price"])
    ) {
      continue;
    }
    const name = firstNonEmptyString(getPath(item, "name"), getPath(item, "title"));
    const headline = firstNonEmptyString(
      getPath(item, "headline"),
      getPath(item, "description"),
      getPath(item, "subtitle"),
      getPath(item, "bio"),
    );
    const url = firstNonEmptyString(getPath(item, "url"), getPath(item, "link"));
    const publicIdentifier = firstNonEmptyString(getPath(item, "public_identifier"), getPath(item, "username"));
    if (!name || name.includes("/") || name.includes("://")) continue;
    if (!headline && !url && !publicIdentifier) continue;
    const id = publicIdentifier ?? url ?? name;
    if (seen.has(id)) continue;
    rows.push({
      name,
      ...(headline ? { headline } : {}),
      ...(url ? { url } : {}),
      ...(publicIdentifier ? { public_identifier: publicIdentifier } : {}),
    });
    seen.add(id);
  }

  return rows;
}

function normalizeRedditPosts(data: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  collectNestedObjects(data, (obj) => {
    const kind = getPath(obj, "kind");
    const payload = isRecord(getPath(obj, "data")) ? getPath(obj, "data") : obj;
    if (!isRecord(payload)) return;
    const title = getPath(payload, "title");
    const author = getPath(payload, "author");
    const permalink = getPath(payload, "permalink");
    if (!hasNonEmptyString(title) || !hasNonEmptyString(author) || !hasNonEmptyString(permalink)) return;
    if (hasNonEmptyString(kind) && kind !== "t3") return;
    const id = getPath(payload, "id") ?? getPath(payload, "name") ?? permalink;
    if (!hasNonEmptyString(id) || seen.has(String(id))) return;
    rows.push({
      id: String(id),
      title: String(title),
      author: String(author),
      ...(typeof getPath(payload, "score") === "number" ? { score: getPath(payload, "score") } : {}),
      ...(typeof getPath(payload, "num_comments") === "number" ? { num_comments: getPath(payload, "num_comments") } : {}),
      ...(hasNonEmptyString(getPath(payload, "subreddit")) ? { subreddit: String(getPath(payload, "subreddit")) } : {}),
      permalink: String(permalink),
      url: `https://www.reddit.com${String(permalink)}`,
    });
    seen.add(String(id));
  });
  return rows;
}

function normalizeRedditComments(data: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  collectNestedObjects(data, (obj) => {
    const kind = getPath(obj, "kind");
    const payload = isRecord(getPath(obj, "data")) ? getPath(obj, "data") : obj;
    if (!isRecord(payload)) return;
    const body = getPath(payload, "body");
    const author = getPath(payload, "author");
    const permalink = getPath(payload, "permalink");
    if (!hasNonEmptyString(body) || !hasNonEmptyString(author) || !hasNonEmptyString(permalink)) return;
    if (hasNonEmptyString(kind) && kind !== "t1") return;
    const id = getPath(payload, "id") ?? getPath(payload, "name") ?? permalink;
    if (!hasNonEmptyString(id) || seen.has(String(id))) return;
    rows.push({
      id: String(id),
      author: String(author),
      body: String(body),
      permalink: String(permalink),
      url: `https://www.reddit.com${String(permalink)}`,
    });
    seen.add(String(id));
  });
  return rows;
}

function normalizeCompanies(data: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  collectNestedObjects(data, (obj) => {
    const name = getPath(obj, "name") ?? getPath(obj, "title");
    const publicIdentifier =
      getPath(obj, "public_identifier") ??
      getPath(obj, "vanityName") ??
      getPath(obj, "universalName");
    const description =
      getPath(obj, "description") ??
      getPath(obj, "tagline") ??
      getPath(obj, "headline");
    const industry = getPath(obj, "industry") ?? getPath(obj, "primaryIndustry");
    const employeeCount =
      getPath(obj, "employee_count") ??
      getPath(obj, "staffCount") ??
      getPath(obj, "employeeCount");
    const followerCount =
      getPath(obj, "follower_count") ??
      getPath(obj, "followerCount");
    const website = getPath(obj, "website") ?? getPath(obj, "websiteUrl");
    const url =
      getPath(obj, "url") ??
      (hasNonEmptyString(publicIdentifier)
        ? `https://www.linkedin.com/company/${encodeURIComponent(String(publicIdentifier))}/`
        : undefined);
    if (!hasNonEmptyString(name)) return;
    if (
      !hasNonEmptyString(description) &&
      !hasNonEmptyString(industry) &&
      typeof employeeCount !== "number" &&
      typeof followerCount !== "number" &&
      !hasNonEmptyString(website) &&
      !hasNonEmptyString(url) &&
      !hasNonEmptyString(publicIdentifier)
    ) {
      return;
    }
    const id = String(publicIdentifier ?? url ?? name);
    if (seen.has(id)) return;
    rows.push({
      name: String(name),
      ...(hasNonEmptyString(publicIdentifier) ? { public_identifier: String(publicIdentifier) } : {}),
      ...(hasNonEmptyString(description) ? { description: String(description) } : {}),
      ...(hasNonEmptyString(industry) ? { industry: String(industry) } : {}),
      ...(typeof employeeCount === "number" ? { employee_count: employeeCount } : {}),
      ...(typeof followerCount === "number" ? { follower_count: followerCount } : {}),
      ...(hasNonEmptyString(website) ? { website: String(website) } : {}),
      ...(hasNonEmptyString(url) ? { url: String(url) } : {}),
    });
    seen.add(id);
  });
  return rows;
}

function unwrapCarrier(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("data" in data && ("_extraction" in data || Array.isArray(data.data) || isRecord(data.data))) {
    return unwrapCarrier(data.data);
  }
  return data;
}

export function projectIntentData(data: unknown, intent?: string): unknown {
  const unwrapped = unwrapCarrier(data);
  if (!intent) return unwrapped;
  const lower = intent.toLowerCase();

  if (/\b(package|packages)\b/.test(lower)) {
    if (/\bsearch\b/.test(lower)) {
      const normalizedPackageSearch = normalizePackageSearchResults(unwrapped);
      if (normalizedPackageSearch.length > 0) return normalizedPackageSearch;
      if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).packages)) {
        return (unwrapped as Record<string, unknown>).packages;
      }
    } else {
      const normalizedNpmPackage = normalizeNpmPackageInfo(unwrapped);
      if (normalizedNpmPackage) return normalizedNpmPackage;
      const normalizedPyPIPackage = normalizePyPIPackageInfo(unwrapped);
      if (normalizedPyPIPackage) return normalizedPyPIPackage;
      if (isRecord(unwrapped) && isRecord((unwrapped as Record<string, unknown>).package)) {
        return (unwrapped as Record<string, unknown>).package;
      }
    }
  }

  if (/\bsearch images\b/.test(lower)) {
    const normalizedImageSearch = normalizeDockerImageSearchResults(unwrapped);
    if (normalizedImageSearch.length > 0) return normalizedImageSearch;
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).images)) {
      return (unwrapped as Record<string, unknown>).images;
    }
  }

  if (/\b(get )?image tags\b/.test(lower)) {
    const normalizedImageTags = normalizeDockerTagResults(unwrapped);
    if (normalizedImageTags.length > 0) return normalizedImageTags;
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).tags)) {
      return (unwrapped as Record<string, unknown>).tags;
    }
  }

  if (/\b(comment|comments)\b/.test(lower)) {
    const normalizedRedditComments = normalizeRedditComments(unwrapped);
    if (normalizedRedditComments.length > 0) return normalizedRedditComments;
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).comments)) {
      return (unwrapped as Record<string, unknown>).comments;
    }
  }

  if (/\b(reddit|subreddit)\b/.test(lower)) {
    const normalizedRedditPosts = normalizeRedditPosts(unwrapped);
    if (normalizedRedditPosts.length > 0) return normalizedRedditPosts;
  }

  if (/\b(company|companies|organization|organisations|business)\b/.test(lower)) {
    const normalizedCompanies = normalizeCompanies(unwrapped);
    if (normalizedCompanies.length === 1) return normalizedCompanies[0];
    if (normalizedCompanies.length > 1) return normalizedCompanies;
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).companies)) {
      return (unwrapped as Record<string, unknown>).companies;
    }
  }

  if (!isRecord(unwrapped) && !Array.isArray(unwrapped)) return unwrapped;

  if (/\b(post|posts|tweet|tweets|status|statuses)\b/.test(lower)) {
    if (Array.isArray(unwrapped.statuses)) return unwrapped.statuses;
    if (Array.isArray(unwrapped.posts)) return unwrapped.posts;
    if (Array.isArray(unwrapped.tweets)) return unwrapped.tweets;
    const normalizedRedditPosts = normalizeRedditPosts(unwrapped);
    if (normalizedRedditPosts.length > 0) return normalizedRedditPosts;
    const normalizedXTweets = normalizeXTweets(unwrapped);
    if (normalizedXTweets.length > 0) return normalizedXTweets;
  }

  if (/\b(person|people|user|users|profile|profiles|member|members)\b/.test(lower)) {
    if (Array.isArray(unwrapped.people)) return unwrapped.people;
    if (Array.isArray(unwrapped.users)) return unwrapped.users;
    if (Array.isArray(unwrapped.accounts)) return unwrapped.accounts;
    if (Array.isArray(unwrapped.elements)) return unwrapped.elements;
    if (Array.isArray(unwrapped.included)) return unwrapped.included;
    const normalizedXUsers = normalizeXUsers(unwrapped);
    if (normalizedXUsers.length > 0) return normalizedXUsers;
    const normalizedGenericPeople = normalizeGenericPeopleRows(unwrapped);
    if (normalizedGenericPeople.length > 0) return normalizedGenericPeople;
  }

  if (/\b(topic|topics|trend|trending|hashtag|hashtags)\b/.test(lower)) {
    const storyItems = getPath(unwrapped, "story_topic.stories.items");
    if (Array.isArray(storyItems)) {
      const normalized = storyItems
        .map((item) => {
          const core = getPath(item, "trend_results.result.core");
          const name = getPath(core, "name");
          const restId = getPath(item, "trend_results.result.rest_id");
          if (!hasNonEmptyString(name)) return null;
          return {
            name,
            ...(hasNonEmptyString(getPath(core, "category")) ? { category: getPath(core, "category") } : {}),
            ...(hasNonEmptyString(getPath(item, "trend_results.result.post_count")) ? { post_count: getPath(item, "trend_results.result.post_count") } : {}),
            ...(hasNonEmptyString(restId)
              ? { url: `https://x.com/search?q=${encodeURIComponent(String(name))}&src=trend_click&trend_id=${encodeURIComponent(String(restId))}` }
              : { url: `https://x.com/search?q=${encodeURIComponent(String(name))}` }),
          };
        })
        .filter((item): item is Record<string, unknown> => !!item);
      if (normalized.length > 0) return normalized;
    }
    if (Array.isArray(unwrapped.topics)) return unwrapped.topics;
    if (Array.isArray(unwrapped.trends)) return unwrapped.trends;
    if (Array.isArray(unwrapped.hashtags)) return unwrapped.hashtags;
  }

  if (/\b(repo|repository|repositories|project|projects)\b/.test(lower)) {
    if (Array.isArray(unwrapped.repositories)) return unwrapped.repositories;
    if (Array.isArray(unwrapped.items)) return unwrapped.items;
    if (Array.isArray(unwrapped.projects)) return unwrapped.projects;
  }

  return unwrapped;
}

function classifyRows(rows: unknown[], intent: string): { verdict: "pass" | "fail" | "skip"; reason: string } {
  if (rows.length === 0) return { verdict: "fail", reason: "empty_array" };
  if (rows.every((row) => !isRecord(row))) return { verdict: "fail", reason: "primitive_rows" };

  const objects = rows.filter(isRecord);
  if (objects.length === 0) return { verdict: "fail", reason: "primitive_rows" };

  const lower = intent.toLowerCase();

  if (/\b(repo|repository|repositories|project|projects)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["full_name", "name", "repository.name", "path_with_namespace"]) &&
      hasAnyPath(row, ["url", "web_url", "description", "stargazers_count", "stars", "star_count", "forks_count", "owner.login", "owner"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "repository_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(package|packages)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["name", "package.name"]) &&
      hasAnyPath(row, ["version", "description", "summary", "url", "keywords", "requires_dist", "dependencies"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "package_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\bsearch images\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["repo_name", "name", "full_name"]) &&
      hasAnyPath(row, ["short_description", "description", "star_count", "pull_count", "url"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "image_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(get )?image tags\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["name", "tag"]) &&
      hasAnyPath(row, ["last_updated", "updated_at", "full_size", "digest"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "tag_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(company|companies|organization|organisations|business)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["name", "title", "public_identifier"]) &&
      hasAnyPath(row, ["description", "industry", "url", "website", "employee_count", "follower_count"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "company_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(person|people|profile|profiles|member|members|user|users)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["name", "title", "public_identifier", "username"]) &&
      hasAnyPath(row, ["headline", "url", "public_identifier", "username"])
    );
    const minRows = /\b(profile|profiles|user|users|person)\b/.test(lower) && !/\bsearch\b/.test(lower) ? 1 : 2;
    return matching.length >= minRows ? { verdict: "pass", reason: "people_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(comment|comments)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["id", "url", "permalink"]) &&
      hasAnyPath(row, ["author", "body", "text"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "comment_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(post|posts|tweet|tweets|status|statuses)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["id", "url", "uri"]) &&
      hasAnyPath(row, ["content", "text", "title", "account.username", "account.acct", "username"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "post_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(reddit|subreddit)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["id", "url", "permalink"]) &&
      hasAnyPath(row, ["title", "subreddit", "author"]) &&
      hasAnyPath(row, ["num_comments", "score", "permalink"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "reddit_post_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(topic|topics|trend|trending|hashtag|hashtags)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["name", "title", "query"]) &&
      hasAnyPath(row, ["url", "name", "query"])
    );
    return matching.length >= 2 ? { verdict: "pass", reason: "topic_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  return { verdict: "skip", reason: "unclassified_array" };
}

export function assessIntentResult(data: unknown, intent?: string): {
  verdict: "pass" | "fail" | "skip";
  reason: string;
  projected: unknown;
} {
  const projected = projectIntentData(data, intent);

  if (projected == null) return { verdict: "fail", reason: "no_data", projected };
  if (typeof projected === "string") {
    const trimmed = projected.trim().toLowerCase();
    if (!trimmed) return { verdict: "fail", reason: "empty_text", projected };
    if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.startsWith("<body")) {
      return { verdict: "fail", reason: "html_payload", projected };
    }
    return { verdict: "skip", reason: "plain_text", projected };
  }

  if (Array.isArray(projected)) {
    const classified = classifyRows(projected, intent ?? "");
    return { ...classified, projected };
  }

  if (isRecord(projected)) {
    if ("error" in projected) return { verdict: "fail", reason: String(projected.error || "error_payload"), projected };
    if ("available_endpoints" in projected || "available_operations" in projected) {
      return { verdict: "fail", reason: "deferral_payload", projected };
    }
    if ("learned_skill_id" in projected && !("data" in projected)) {
      return { verdict: "fail", reason: "learned_skill_only", projected };
    }
    if ("message" in projected && !("data" in projected)) {
      return { verdict: "fail", reason: "message_only", projected };
    }
    const lower = (intent ?? "").toLowerCase();
    if (/\b(company|companies|organization|organisations|business|person|people|profile|profiles|member|members|user|users|repo|repository|repositories|project|projects|package|packages)\b/.test(lower)) {
      const classified = classifyRows([projected], intent ?? "");
      return { ...classified, projected };
    }
  }

  return { verdict: "skip", reason: "unclassified_payload", projected };
}
