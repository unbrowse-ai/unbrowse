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

function countMatchingGroups(obj: unknown, groups: string[][]): number {
  let matches = 0;
  for (const group of groups) {
    if (hasAnyPath(obj, group)) matches++;
  }
  return matches;
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

function looksLikePrimitiveLabel(value: unknown, maxLen = 120): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLen && !/[\r\n]/.test(value);
}

function looksLikePrimitiveName(value: unknown): value is string {
  if (!looksLikePrimitiveLabel(value, 80)) return false;
  const trimmed = value.trim();
  if (/\b(review by|posted on|rating|http|https|www\.)\b/i.test(trimmed)) return false;
  if (/[.!?]{2,}/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  return words.every((word) => /^[\p{L}\p{N}'’.-]+$/u.test(word));
}

function normalizeContentToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/s$/, "");
}

function tokenizeContent(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(normalizeContentToken)
    .filter((token) =>
      token.length >= 3 &&
      !new Set(["the", "and", "for", "with", "that", "this", "from", "into", "onto", "your", "their", "being", "mention", "mentions", "explicitly"]).has(token),
    );
}

function hasTokenWindowMatch(haystack: string, tokens: string[], minMatches: number, maxWindow = 120): boolean {
  const positions = tokens
    .map((token) => ({ token, index: haystack.indexOf(token) }))
    .filter((entry) => entry.index >= 0)
    .sort((lhs, rhs) => lhs.index - rhs.index);
  if (positions.length < minMatches) return false;
  for (let start = 0; start <= positions.length - minMatches; start += 1) {
    const slice = positions.slice(start, start + minMatches);
    if ((slice[slice.length - 1]?.index ?? 0) - (slice[0]?.index ?? 0) <= maxWindow) return true;
  }
  return false;
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

function normalizeCratesPackageSearchResults(data: unknown): Record<string, unknown>[] {
  const sourceRows = isRecord(data) && Array.isArray(data.crates)
    ? data.crates
    : Array.isArray(data)
      ? data
      : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const name = firstNonEmptyString(getPath(item, "name"), getPath(item, "id"));
    if (!name || seen.has(name)) continue;
    const description = firstNonEmptyString(getPath(item, "description"), getPath(item, "summary"));
    const version = firstNonEmptyString(getPath(item, "max_version"), getPath(item, "default_version"), getPath(item, "version"));
    rows.push({
      name,
      ...(description ? { description, summary: description } : {}),
      ...(version ? { version } : {}),
      ...(typeof getPath(item, "downloads") === "number" ? { downloads: getPath(item, "downloads") } : {}),
      url: `https://crates.io/crates/${encodeURIComponent(name)}`,
    });
    seen.add(name);
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
    url: homepage ?? firstNonEmptyString(getPath(data, "url"), getPath(data, "package_url"), getPath(data, "project_url"))
      ?? `https://www.npmjs.com/package/${encodeURIComponent(String(data.name))}`,
  };
}

function normalizeDocumentRows(data: unknown): Record<string, unknown>[] {
  const sourceRows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.documents)
      ? data.documents
      : isRecord(data) && Array.isArray(data.results)
        ? data.results
        : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const title = firstNonEmptyString(getPath(item, "title"), getPath(item, "name"));
    const url = firstNonEmptyString(getPath(item, "url"), getPath(item, "mdn_url"), getPath(item, "link"), getPath(item, "href"));
    if (!title || !url) continue;
    const id = `${title}|${url}`;
    if (seen.has(id)) continue;
    rows.push({
      title,
      url,
      ...(firstNonEmptyString(getPath(item, "summary"), getPath(item, "description"), getPath(item, "slug")) ? {
        summary: firstNonEmptyString(getPath(item, "summary"), getPath(item, "description"), getPath(item, "slug")),
      } : {}),
      ...(typeof getPath(item, "score") === "number" ? { score: getPath(item, "score") } : {}),
      ...(typeof getPath(item, "popularity") === "number" ? { popularity: getPath(item, "popularity") } : {}),
      ...(firstNonEmptyString(getPath(item, "locale")) ? { locale: firstNonEmptyString(getPath(item, "locale")) } : {}),
    });
    seen.add(id);
  }

  return rows;
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

function normalizePubDevPackageInfo(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  const latest = isRecord(data.latest) ? data.latest : undefined;
  const pubspec = isRecord(latest?.pubspec) ? latest?.pubspec : undefined;
  const name = firstNonEmptyString(getPath(data, "name"), getPath(pubspec, "name"));
  if (!name) return null;
  const version = firstNonEmptyString(getPath(latest, "version"), getPath(pubspec, "version"));
  const description = firstNonEmptyString(getPath(pubspec, "description"));
  const repository = firstNonEmptyString(getPath(pubspec, "repository"), getPath(pubspec, "homepage"));
  const topics = toStringArray(getPath(pubspec, "topics"));
  return {
    name,
    ...(version ? { version } : {}),
    ...(description ? { description, summary: description } : {}),
    ...(topics ? { keywords: topics } : {}),
    url: repository ?? `https://pub.dev/packages/${encodeURIComponent(name)}`,
  };
}

function normalizeRubyGemsPackageInfo(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  const name = firstNonEmptyString(getPath(data, "name"));
  if (!name) return null;
  const description = firstNonEmptyString(getPath(data, "info"));
  const version = firstNonEmptyString(getPath(data, "version"));
  const author = firstNonEmptyString(getPath(data, "authors"), getPath(data, "author"));
  const homepage = firstNonEmptyString(getPath(data, "homepage_uri"), getPath(data, "project_uri"), getPath(data, "gem_uri"));
  return {
    name,
    ...(version ? { version } : {}),
    ...(description ? { description, summary: description } : {}),
    ...(author ? { author } : {}),
    url: homepage ?? `https://rubygems.org/gems/${encodeURIComponent(name)}`,
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

function normalizeHackerNewsStories(data: unknown): Record<string, unknown>[] {
  const sourceRows = isRecord(data) && Array.isArray(data.hits)
    ? data.hits
    : Array.isArray(data)
      ? data
      : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const id = firstNonEmptyString(getPath(item, "objectID"), getPath(item, "id"), getPath(item, "story_id"));
    const title = firstNonEmptyString(getPath(item, "title"), getPath(item, "story_title"));
    const url = firstNonEmptyString(getPath(item, "url"), getPath(item, "story_url"), getPath(item, "link"));
    const author = firstNonEmptyString(getPath(item, "author"));
    const meta = firstNonEmptyString(getPath(item, "meta"));
    if (!title) continue;
    const stableId = id ?? url ?? title;
    if (seen.has(stableId)) continue;
    const pointsMatch = meta?.match(/(^|\|)\s*([0-9,]+)\s+points?\b/i);
    const commentsMatch = meta?.match(/(^|\|)\s*([0-9,]+)\s+comments?\b/i);

    rows.push({
      ...(stableId ? { id: stableId } : {}),
      title,
      ...(url ? { url } : {}),
      ...(author ? { author } : {}),
      ...(typeof getPath(item, "points") === "number"
        ? { points: getPath(item, "points") }
        : pointsMatch ? { points: Number(pointsMatch[2]?.replace(/,/g, "")) } : {}),
      ...(typeof getPath(item, "num_comments") === "number"
        ? { num_comments: getPath(item, "num_comments") }
        : commentsMatch ? { num_comments: Number(commentsMatch[2]?.replace(/,/g, "")) } : {}),
      ...(meta ? { meta } : {}),
    });
    seen.add(stableId);
  }

  return rows;
}

function normalizeStackExchangeQuestions(data: unknown): Record<string, unknown>[] {
  const sourceRows = isRecord(data) && Array.isArray(data.items)
    ? data.items
    : Array.isArray(data)
      ? data
      : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const title = firstNonEmptyString(getPath(item, "title"));
    const url = firstNonEmptyString(getPath(item, "link"));
    if (!title || !url || seen.has(url)) continue;
    rows.push({
      title,
      url,
      ...(typeof getPath(item, "score") === "number" ? { score: getPath(item, "score") } : {}),
      ...(typeof getPath(item, "answer_count") === "number" ? { answer_count: getPath(item, "answer_count") } : {}),
      ...(firstNonEmptyString(getPath(item, "owner.display_name")) ? { author: firstNonEmptyString(getPath(item, "owner.display_name")) } : {}),
      ...(typeof getPath(item, "last_activity_date") === "number" ? { date: getPath(item, "last_activity_date") } : {}),
    });
    seen.add(url);
  }
  return rows;
}

function normalizeDevToPosts(data: unknown): Record<string, unknown>[] {
  const sourceRows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.result)
      ? data.result
      : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const inferAuthor = (value: unknown): string | undefined => {
    const raw = hasNonEmptyString(value) ? String(value) : undefined;
    if (!raw) return undefined;
    try {
      const pathname = raw.startsWith("http") ? new URL(raw).pathname : raw;
      const segments = pathname.split("/").filter(Boolean);
      const candidate = segments[0];
      if (!candidate || candidate === "t" || candidate === "s" || candidate === "tag" || candidate === "tags" || candidate === "top" || candidate === "latest") {
        return undefined;
      }
      return candidate;
    } catch {
      return undefined;
    }
  };
  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const title = firstNonEmptyString(getPath(item, "title"));
    const url = firstNonEmptyString(getPath(item, "url"), getPath(item, "path"));
    if (!title || !url) continue;
    const looksLikeDevTo = (
      firstNonEmptyString(getPath(item, "type_of")) === "article" ||
      hasNonEmptyString(getPath(item, "user.name")) ||
      hasNonEmptyString(getPath(item, "user.username")) ||
      typeof getPath(item, "positive_reactions_count") === "number" ||
      typeof getPath(item, "comments_count") === "number" ||
      hasNonEmptyString(getPath(item, "published_at")) ||
      hasNonEmptyString(getPath(item, "readable_publish_date")) ||
      url.startsWith("https://dev.to/") ||
      url.startsWith("http://dev.to/") ||
      (url.startsWith("/") && !!inferAuthor(url))
    );
    if (!looksLikeDevTo) continue;
    const canonicalUrl = url.startsWith("http") ? url : `https://dev.to${url}`;
    if (seen.has(canonicalUrl)) continue;
    const author = firstNonEmptyString(
      getPath(item, "user.name"),
      getPath(item, "user.username"),
      inferAuthor(getPath(item, "path")),
      inferAuthor(canonicalUrl),
    );
    rows.push({
      ...(firstNonEmptyString(getPath(item, "id")) ? { id: firstNonEmptyString(getPath(item, "id")) } : {}),
      title,
      url: canonicalUrl,
      ...(firstNonEmptyString(getPath(item, "description")) ? { description: firstNonEmptyString(getPath(item, "description")) } : {}),
      ...(author ? { author } : {}),
      ...(typeof getPath(item, "positive_reactions_count") === "number" ? { likes: getPath(item, "positive_reactions_count") } : {}),
      ...(typeof getPath(item, "comments_count") === "number" ? { comments: getPath(item, "comments_count") } : {}),
      ...(firstNonEmptyString(getPath(item, "published_at"), getPath(item, "readable_publish_date")) ? { date: firstNonEmptyString(getPath(item, "published_at"), getPath(item, "readable_publish_date")) } : {}),
    });
    seen.add(canonicalUrl);
  }
  return rows;
}

function normalizeLobstersPosts(data: unknown): Record<string, unknown>[] {
  const sourceRows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.results)
      ? data.results
      : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const title = firstNonEmptyString(getPath(item, "title"));
    const rawUrl = firstNonEmptyString(getPath(item, "url"), getPath(item, "link"), getPath(item, "href"));
    const text = firstNonEmptyString(getPath(item, "text"), getPath(item, "body"));
    if (!title || !rawUrl || /^\d+\s+comments?$/i.test(title)) continue;
    const scoreMatch = text?.match(/^\s*(\d{1,4})\s+/)?.[1];
    const score = typeof getPath(item, "score") === "number"
      ? getPath(item, "score")
      : typeof getPath(item, "points") === "number"
        ? getPath(item, "points")
        : scoreMatch ? Number(scoreMatch) : undefined;
    const url = rawUrl.startsWith("http") ? rawUrl : `https://lobste.rs${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
    const stable = `${title}|${url}`;
    if (seen.has(stable)) continue;
    rows.push({
      title,
      url,
      ...(typeof score === "number" ? { score } : {}),
      ...(firstNonEmptyString(getPath(item, "author"), getPath(item, "username")) ? { author: firstNonEmptyString(getPath(item, "author"), getPath(item, "username")) } : {}),
    });
    seen.add(stable);
  }
  return rows;
}

function normalizeHuggingFaceModels(data: unknown): Record<string, unknown>[] {
  const sourceRows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.models)
      ? data.models
      : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const id = firstNonEmptyString(getPath(item, "id"), getPath(item, "modelId"), getPath(item, "name"), getPath(item, "title"));
    if (!id || seen.has(id)) continue;
    const name = firstNonEmptyString(getPath(item, "name"), getPath(item, "title"), getPath(item, "modelId"), getPath(item, "id"));
    rows.push({
      id,
      ...(name ? { name } : {}),
      ...(typeof getPath(item, "downloads") === "number" ? { downloads: getPath(item, "downloads") } : {}),
      ...(typeof getPath(item, "likes") === "number" ? { likes: getPath(item, "likes") } : {}),
      ...(firstNonEmptyString(getPath(item, "pipeline_tag"), getPath(item, "task")) ? {
        pipeline_tag: firstNonEmptyString(getPath(item, "pipeline_tag"), getPath(item, "task")),
      } : {}),
      url: firstNonEmptyString(getPath(item, "url"), getPath(item, "link"))
        ?? `https://huggingface.co/${encodeURI(id)}`,
    });
    seen.add(id);
  }

  return rows;
}

function normalizeEmailRows(data: unknown): Record<string, unknown>[] {
  const sourceRows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.results)
      ? data.results
      : isRecord(data) && Array.isArray(data.emails)
        ? data.emails
        : isRecord(data) && Array.isArray(data.messages)
          ? data.messages
          : [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of sourceRows) {
    if (!isRecord(item)) continue;
    const thread = isRecord(getPath(item, "thread")) ? getPath(item, "thread") as Record<string, unknown> : item;
    const message = isRecord(getPath(item, "matchedEmail")) ? getPath(item, "matchedEmail") as Record<string, unknown> : item;
    const id = firstNonEmptyString(
      getPath(message, "id"),
      getPath(thread, "doc_id"),
      getPath(item, "id"),
      getPath(item, "doc_id"),
    );
    if (!id || seen.has(id)) continue;
    const subject = firstNonEmptyString(getPath(thread, "subject"), getPath(item, "subject"), getPath(message, "subject"));
    const from = firstNonEmptyString(
      getPath(message, "sender"),
      getPath(thread, "latest_sender_name"),
      getPath(item, "from"),
      getPath(item, "sender"),
    );
    const date = firstNonEmptyString(getPath(thread, "formatted_date"), getPath(item, "date"), getPath(message, "date"));
    const preview = firstNonEmptyString(
      getPath(thread, "preview"),
      getPath(message, "content_markdown"),
      getPath(item, "preview"),
      getPath(item, "snippet"),
    );
    if (!subject && !from) continue;
    rows.push({
      id,
      ...(subject ? { subject } : {}),
      ...(from ? { from } : {}),
      ...(date ? { date } : {}),
      ...(preview ? { preview } : {}),
    });
    seen.add(id);
  }

  return rows;
}

function normalizeProductRows(data: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const blockedTitles = new Set(["results", "more results", "related searches", "need help?"]);

  collectNestedObjects(data, (obj) => {
    const headingKeys = Object.keys(obj).filter((key) => /^heading_\d+$/i.test(key));
    const title = firstNonEmptyString(
      getPath(obj, "title"),
      getPath(obj, "name"),
      getPath(obj, "productName"),
      getPath(obj, "productTitle"),
      getPath(obj, "title.text"),
    );
    const url = firstNonEmptyString(
      getPath(obj, "url"),
      getPath(obj, "link"),
      getPath(obj, "href"),
      getPath(obj, "canonicalUrl"),
      getPath(obj, "productUrl"),
      getPath(obj, "productPageUrl"),
    );
    const id = firstNonEmptyString(
      getPath(obj, "id"),
      getPath(obj, "usItemId"),
      getPath(obj, "itemId"),
      getPath(obj, "productId"),
      getPath(obj, "sku"),
    );
    const priceString = firstNonEmptyString(
      getPath(obj, "price"),
      getPath(obj, "priceString"),
      getPath(obj, "price.currentPrice.priceString"),
      getPath(obj, "priceInfo.currentPrice.priceString"),
      getPath(obj, "secondaryOfferPrice.currentPrice.priceString"),
    );
    const priceNumber = getPath(obj, "price.currentPrice.price")
      ?? getPath(obj, "priceInfo.currentPrice.price")
      ?? getPath(obj, "currentPrice.price")
      ?? getPath(obj, "salePrice");
    const rating = getPath(obj, "averageRating")
      ?? getPath(obj, "rating")
      ?? getPath(obj, "rating.average")
      ?? getPath(obj, "customerRating")
      ?? getPath(obj, "reviews.averageRating");
    const reviewCount = getPath(obj, "numberOfReviews")
      ?? getPath(obj, "reviewCount")
      ?? getPath(obj, "reviews.count")
      ?? getPath(obj, "ratingsTotal");
    const image = firstNonEmptyString(
      getPath(obj, "image"),
      getPath(obj, "imageUrl"),
      getPath(obj, "thumbnail"),
      getPath(obj, "primaryImageUrl"),
    );
    const brand = firstNonEmptyString(getPath(obj, "brand"), getPath(obj, "brandName"), getPath(obj, "seller"));

    if (!title && !id) return;
    if (title && blockedTitles.has(title.trim().toLowerCase())) return;
    if (headingKeys.length >= 6) return;
    if (!url && !id) return;
    if (
      priceString == null &&
      typeof priceNumber !== "number" &&
      rating == null &&
      reviewCount == null &&
      !image &&
      !brand
    ) {
      return;
    }
    if (url && /(amazon-adsystem|doubleclick|googlesyndication|pubmatic|taboola|outbrain|aax-|googleadservices|adservice)\./i.test(url)) {
      return;
    }

    const stable = String(url ?? id ?? title);
    if (seen.has(stable)) return;
    rows.push({
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(priceString ? { price: priceString } : typeof priceNumber === "number" ? { price: priceNumber } : {}),
      ...(typeof rating === "number" || hasNonEmptyString(rating) ? { rating } : {}),
      ...(typeof reviewCount === "number" || hasNonEmptyString(reviewCount) ? { review_count: reviewCount } : {}),
      ...(image ? { image } : {}),
      ...(brand ? { brand } : {}),
    });
    seen.add(stable);
  });

  return rows;
}

function normalizeStockQuote(data: unknown): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;

  collectNestedObjects(data, (obj) => {
    const symbol = firstNonEmptyString(
      getPath(obj, "symbol"),
      getPath(obj, "ticker"),
      getPath(obj, "quote.symbol"),
    );
    const price = getPath(obj, "regularMarketPrice.raw")
      ?? getPath(obj, "regularMarketPrice")
      ?? getPath(obj, "postMarketPrice.raw")
      ?? getPath(obj, "price.regularMarketPrice.raw")
      ?? getPath(obj, "price.regularMarketPrice")
      ?? getPath(obj, "price.currentPrice.raw")
      ?? getPath(obj, "price.currentPrice");
    if (!symbol || typeof price !== "number") return;
    const name = firstNonEmptyString(
      getPath(obj, "shortName"),
      getPath(obj, "longName"),
      getPath(obj, "displayName"),
      getPath(obj, "price.shortName"),
      getPath(obj, "price.longName"),
    );
    const currency = firstNonEmptyString(getPath(obj, "currency"), getPath(obj, "financialCurrency"), getPath(obj, "price.currency"));
    const marketState = firstNonEmptyString(getPath(obj, "marketState"), getPath(obj, "price.marketState"));
    const changePercent = getPath(obj, "regularMarketChangePercent.raw")
      ?? getPath(obj, "regularMarketChangePercent")
      ?? getPath(obj, "price.regularMarketChangePercent.raw")
      ?? getPath(obj, "price.regularMarketChangePercent");
    const marketCap = getPath(obj, "marketCap.raw")
      ?? getPath(obj, "marketCap")
      ?? getPath(obj, "price.marketCap.raw")
      ?? getPath(obj, "price.marketCap");
    best = {
      symbol,
      ...(name ? { name } : {}),
      price,
      ...(currency ? { currency } : {}),
      ...(typeof changePercent === "number" ? { change_percent: changePercent } : {}),
      ...(typeof marketCap === "number" ? { market_cap: marketCap } : {}),
      ...(marketState ? { market_state: marketState } : {}),
    };
  });

  return best;
}

function normalizeChannelRows(data: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  collectNestedObjects(data, (obj) => {
    const name = firstNonEmptyString(
      getPath(obj, "name"),
      getPath(obj, "title"),
      getPath(obj, "channel_name"),
      getPath(obj, "workspace_name"),
      getPath(obj, "team_name"),
    );
    const id = firstNonEmptyString(
      getPath(obj, "id"),
      getPath(obj, "channel_id"),
      getPath(obj, "guild_id"),
      getPath(obj, "server_id"),
      getPath(obj, "workspace_id"),
      getPath(obj, "team_id"),
    );
    const url = firstNonEmptyString(
      getPath(obj, "url"),
      getPath(obj, "channel_url"),
      getPath(obj, "server_url"),
      getPath(obj, "workspace_url"),
    );
    if (!name || (!id && !url)) return;
    const stable = String(id ?? url ?? name);
    if (seen.has(stable)) return;
    rows.push({
      ...(id ? { id } : {}),
      name,
      ...(url ? { url } : {}),
      ...(firstNonEmptyString(getPath(obj, "topic"), getPath(obj, "purpose"), getPath(obj, "description")) ? {
        description: firstNonEmptyString(getPath(obj, "topic"), getPath(obj, "purpose"), getPath(obj, "description")),
      } : {}),
      ...(typeof getPath(obj, "member_count") === "number" ? { member_count: getPath(obj, "member_count") } : {}),
      ...(firstNonEmptyString(getPath(obj, "type"), getPath(obj, "channel_type"), getPath(obj, "kind")) ? {
        type: firstNonEmptyString(getPath(obj, "type"), getPath(obj, "channel_type"), getPath(obj, "kind")),
      } : {}),
    });
    seen.add(stable);
  });

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

function joinNameParts(...values: unknown[]): string | undefined {
  const parts = values.filter((value) => hasNonEmptyString(value)).map((value) => String(value).trim());
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function absoluteLinkedInUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("http") ? value : `https://www.linkedin.com${value.startsWith("/") ? "" : "/"}${value}`;
}

function isFeedPostIntent(lower: string): boolean {
  return (
    /\b(post|posts|tweet|tweets|status|statuses|update|updates)\b/.test(lower) ||
    /\b(feed|timeline|stream|home|for-you|for_you|latest)\b/.test(lower)
  );
}

function normalizeLinkedInFeedPosts(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data)) return [];

  const included = Array.isArray(getPath(data, "included"))
    ? getPath(data, "included") as unknown[]
    : Array.isArray(getPath(data, "data.included"))
      ? getPath(data, "data.included") as unknown[]
      : [];

  const feed =
    (isRecord(getPath(data, "data.data.feedDashMainFeedByMainFeed"))
      ? getPath(data, "data.data.feedDashMainFeedByMainFeed")
      : isRecord(getPath(data, "data.feedDashMainFeedByMainFeed"))
        ? getPath(data, "data.feedDashMainFeedByMainFeed")
        : isRecord(getPath(data, "feedDashMainFeedByMainFeed"))
          ? getPath(data, "feedDashMainFeedByMainFeed")
          : null) as Record<string, unknown> | null;
  if (!feed) return [];

  const elementRefs = Array.isArray(feed["*elements"])
    ? feed["*elements"] as unknown[]
    : Array.isArray(feed.elements)
      ? feed.elements as unknown[]
      : [];
  if (elementRefs.length === 0) return [];

  const entityIndex = new Map<string, Record<string, unknown>>();
  for (const item of included) {
    if (!isRecord(item)) continue;
    const urn = getPath(item, "entityUrn");
    if (!hasNonEmptyString(urn)) continue;
    entityIndex.set(String(urn), item);
  }

  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const ref of elementRefs) {
    const update = hasNonEmptyString(ref)
      ? entityIndex.get(String(ref))
      : isRecord(ref)
        ? ref
        : null;
    if (!update) continue;
    const rowId = firstNonEmptyString(
      hasNonEmptyString(ref) ? ref : undefined,
      getPath(update, "entityUrn"),
      getPath(update, "socialContent.shareUrl"),
      getPath(update, "permalink"),
      getPath(update, "url"),
    );
    if (!rowId || seen.has(rowId)) continue;

    const actorProfileUrn = firstNonEmptyString(getPath(update, "actor.*profileUrn"), getPath(update, "actor.entityUrn"));
    const actorProfile = actorProfileUrn ? entityIndex.get(actorProfileUrn) : undefined;
    const author = firstNonEmptyString(
      getPath(update, "actor.name.text"),
      getPath(update, "actor.title.text"),
      getPath(actorProfile, "name"),
      joinNameParts(getPath(actorProfile, "firstName"), getPath(actorProfile, "lastName")),
    );
    const username = firstNonEmptyString(getPath(actorProfile, "publicIdentifier"));
    const content = firstNonEmptyString(
      getPath(update, "commentary.text.text"),
      getPath(update, "commentary.accessibilityText"),
      getPath(update, "content.text"),
      getPath(update, "content.title"),
      getPath(update, "header.text"),
      getPath(update, "header.title"),
    );
    const permalink = firstNonEmptyString(
      getPath(update, "permalink"),
      getPath(update, "socialContent.shareUrl"),
      getPath(update, "url"),
    );
    const url = absoluteLinkedInUrl(permalink) ?? `https://www.linkedin.com/feed/update/${encodeURIComponent(String(ref))}/`;

    if (!content && !username && !author) continue;

    rows.push({
      id: rowId,
      url,
      ...(content ? { content } : {}),
      ...(author ? { author } : {}),
      ...(username ? { username, public_identifier: username } : {}),
      ...(typeof getPath(update, "socialDetail.totalSocialActivityCounts.numLikes") === "number"
        ? { likes: getPath(update, "socialDetail.totalSocialActivityCounts.numLikes") }
        : {}),
      ...(typeof getPath(update, "socialDetail.totalSocialActivityCounts.numComments") === "number"
        ? { num_comments: getPath(update, "socialDetail.totalSocialActivityCounts.numComments") }
        : {}),
      ...(typeof getPath(update, "createdAt") === "number" ? { created_at: getPath(update, "createdAt") } : {}),
    });
    seen.add(rowId);
  }

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
  const keys = Object.keys(data);
  const isCarrierOnly = keys.every((key) => key === "data" || key === "_extraction");
  if (isCarrierOnly && "data" in data && ("_extraction" in data || Array.isArray(data.data) || isRecord(data.data))) {
    return unwrapCarrier(data.data);
  }
  return data;
}

export function projectIntentData(data: unknown, intent?: string): unknown {
  const unwrapped = unwrapCarrier(data);
  if (!intent) return unwrapped;
  const lower = intent.toLowerCase();

  const parseRequestedCount = (): number | null => {
    const m = lower.match(/\btop\s+(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const quotedTerm = (() => {
    const m = intent.match(/"([^"]+)"/);
    return m?.[1]?.trim().toLowerCase() || "";
  })();
  const mentionPhrase = (() => {
    const quoted = quotedTerm;
    if (quoted) return quoted;
    const m = intent.match(/\bmention(?:ing)?\s+(.+?)(?:\s+with a rating|\s+on the current page|\s+for the product|\.\s|$)/i);
    return (m?.[1] ?? "")
      .replace(/\bexplicitly\b/gi, "")
      .trim()
      .toLowerCase();
  })();
  const mentionTokens = Array.from(new Set(tokenizeContent(mentionPhrase)));
  const maxRating = (() => {
    const m = lower.match(/\brating of\s+(\d+)\s+or less\b/);
    return m ? Number(m[1]) : null;
  })();
  const forumCountIntent = /\bcount the number of comments\b/.test(lower) && /\bpost title\b/.test(lower) && /\busername\b/.test(lower);
  const asRows = Array.isArray(unwrapped)
    ? unwrapped.filter((row): row is Record<string, unknown> => isRecord(row))
    : [];

  if (/\bsearch term/.test(lower) && asRows.length > 0) {
    const terms = asRows
      .map((row) => firstNonEmptyString(getPath(row, "term"), getPath(row, "title"), getPath(row, "name")))
      .filter((value): value is string => hasNonEmptyString(value));
    if (terms.length > 0) {
      const limit = parseRequestedCount() ?? terms.length;
      return terms.slice(0, limit);
    }
  }

  if ((/\btotal number of reviews\b/.test(lower) || /\breviewer/.test(lower)) && asRows.length > 0) {
    const reviews = asRows
      .map((row) => ({
        author: firstNonEmptyString(getPath(row, "author"), getPath(row, "username"), getPath(row, "name")),
        title: firstNonEmptyString(getPath(row, "title"), getPath(row, "summary")),
        body: firstNonEmptyString(getPath(row, "body"), getPath(row, "description"), getPath(row, "content"), getPath(row, "text")),
        rating: Number(getPath(row, "rating") ?? getPath(row, "ratingValue") ?? NaN),
      }))
      .filter((row) => hasNonEmptyString(row.body) || hasNonEmptyString(row.title));

    if (reviews.length > 0 && /\btotal number of reviews\b/.test(lower) && quotedTerm) {
      const count = reviews.filter((row) => `${row.title ?? ""} ${row.body ?? ""}`.toLowerCase().includes(quotedTerm)).length;
      return [count];
    }

    if (reviews.length > 0 && /\breviewer/.test(lower) && mentionPhrase) {
      const matching = reviews.filter((row) => {
        const haystack = `${row.title ?? ""} ${row.body ?? ""}`.toLowerCase();
        const normalizedHaystack = tokenizeContent(haystack).join(" ");
        const exact = haystack.includes(mentionPhrase);
        const overlap = mentionTokens.length > 0
          ? mentionTokens.filter((token) => normalizedHaystack.includes(token)).length
          : 0;
        const fuzzy = mentionTokens.length > 0
          ? hasTokenWindowMatch(normalizedHaystack, mentionTokens, Math.min(2, mentionTokens.length))
          : false;
        if (!exact && (!fuzzy || overlap < Math.min(2, mentionTokens.length))) return false;
        if (maxRating != null && Number.isFinite(row.rating)) return row.rating <= maxRating;
        return true;
      });
      const authors = [...new Set(matching.map((row) => row.author).filter((value): value is string => hasNonEmptyString(value)))];
      if (authors.length > 0) return authors;
    }
  }

  if (forumCountIntent && asRows.length > 0) {
    const comments = asRows
      .map((row) => ({
        author: firstNonEmptyString(getPath(row, "author"), getPath(row, "username"), getPath(row, "name")),
        postAuthor: firstNonEmptyString(getPath(row, "post_author"), getPath(row, "postAuthor"), getPath(row, "submission_author")),
        postTitle: firstNonEmptyString(getPath(row, "post_title"), getPath(row, "postTitle"), getPath(row, "submission_title"), getPath(row, "title")),
        score: Number(String(getPath(row, "score") ?? getPath(row, "votes") ?? "").replace(/,/g, "")),
      }))
      .filter((row) => hasNonEmptyString(row.author) && hasNonEmptyString(row.postAuthor) && hasNonEmptyString(row.postTitle));
    if (comments.length > 0) {
      const first = comments[0]!;
      const count = comments.filter((row) => row.author !== row.postAuthor && Number.isFinite(row.score) && row.score < 0).length;
      return [{
        username: first.postAuthor,
        post_title: first.postTitle,
        count,
      }];
    }
  }

  if (/\b(stock|stocks|ticker|tickers|quote|quotes)\b/.test(lower)) {
    const normalizedQuote = normalizeStockQuote(unwrapped);
    if (normalizedQuote) return normalizedQuote;
  }

  if (/\b(product|products|item|items)\b/.test(lower)) {
    const normalizedProducts = normalizeProductRows(unwrapped);
    if (normalizedProducts.length > 0) return normalizedProducts;
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).products)) {
      return (unwrapped as Record<string, unknown>).products;
    }
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).items)) {
      return (unwrapped as Record<string, unknown>).items;
    }
  }

  if (/\b(channel|channels|server|servers|guild|guilds|workspace|workspaces)\b/.test(lower)) {
    const normalizedChannels = normalizeChannelRows(unwrapped);
    if (normalizedChannels.length > 0) return normalizedChannels;
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).channels)) {
      return (unwrapped as Record<string, unknown>).channels;
    }
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).guilds)) {
      return (unwrapped as Record<string, unknown>).guilds;
    }
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).workspaces)) {
      return (unwrapped as Record<string, unknown>).workspaces;
    }
  }

  if (/\b(package|packages)\b/.test(lower)) {
    if (/\bsearch\b/.test(lower)) {
      const normalizedCratesSearch = normalizeCratesPackageSearchResults(unwrapped);
      if (normalizedCratesSearch.length > 0) return normalizedCratesSearch;
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
      const normalizedPubDevPackage = normalizePubDevPackageInfo(unwrapped);
      if (normalizedPubDevPackage) return normalizedPubDevPackage;
      const normalizedRubyGemsPackage = normalizeRubyGemsPackageInfo(unwrapped);
      if (normalizedRubyGemsPackage) return normalizedRubyGemsPackage;
      if (isRecord(unwrapped) && isRecord((unwrapped as Record<string, unknown>).package)) {
        return (unwrapped as Record<string, unknown>).package;
      }
    }
  }

  if (/\b(doc|docs|documentation)\b/.test(lower)) {
    const normalizedDocuments = normalizeDocumentRows(unwrapped);
    if (normalizedDocuments.length > 0) return normalizedDocuments;
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).documents)) {
      return (unwrapped as Record<string, unknown>).documents;
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

  if (isFeedPostIntent(lower)) {
    const normalizedDevPosts = normalizeDevToPosts(unwrapped);
    if (normalizedDevPosts.length > 0) return normalizedDevPosts;
    const normalizedLobsters = normalizeLobstersPosts(unwrapped);
    if (normalizedLobsters.length > 0) return normalizedLobsters;
    const normalizedLinkedInFeed = normalizeLinkedInFeedPosts(unwrapped);
    if (normalizedLinkedInFeed.length > 0) return normalizedLinkedInFeed;
    const normalizedRedditPosts = normalizeRedditPosts(unwrapped);
    if (normalizedRedditPosts.length > 0) return normalizedRedditPosts;
    const normalizedXTweets = normalizeXTweets(unwrapped);
    if (normalizedXTweets.length > 0) return normalizedXTweets;
    if (Array.isArray(unwrapped)) return unwrapped;
    if (Array.isArray(unwrapped.statuses)) return unwrapped.statuses;
    if (Array.isArray(unwrapped.posts)) return unwrapped.posts;
    if (Array.isArray(unwrapped.tweets)) return unwrapped.tweets;
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

  if (/\b(model|models)\b/.test(lower)) {
    const normalizedModels = normalizeHuggingFaceModels(unwrapped);
    if (normalizedModels.length > 0) return normalizedModels;
    if (Array.isArray(unwrapped.models)) return unwrapped.models;
  }

  if (/\b(news|story|stories|article|articles|hacker news)\b/.test(lower)) {
    if (Array.isArray(unwrapped)) return unwrapped;
    const normalizedStories = normalizeHackerNewsStories(unwrapped);
    if (normalizedStories.length > 0) return normalizedStories;
    if (Array.isArray(unwrapped.hits)) return unwrapped.hits;
    if (Array.isArray(unwrapped.stories)) return unwrapped.stories;
    if (Array.isArray(unwrapped.articles)) return unwrapped.articles;
  }

  if (/\b(question|questions)\b/.test(lower)) {
    if (Array.isArray(unwrapped)) return unwrapped;
    const normalizedQuestions = normalizeStackExchangeQuestions(unwrapped);
    if (normalizedQuestions.length > 0) return normalizedQuestions;
    if (Array.isArray(unwrapped.items)) return unwrapped.items;
  }

  if (/\b(search|find|lookup)\b/.test(lower)) {
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).docs)) {
      return (unwrapped as Record<string, unknown>).docs;
    }
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).results)) {
      return (unwrapped as Record<string, unknown>).results;
    }
    if (isRecord(unwrapped) && Array.isArray((unwrapped as Record<string, unknown>).items)) {
      return (unwrapped as Record<string, unknown>).items;
    }
  }

  if (/\b(email|emails|mail|inbox)\b/.test(lower)) {
    const normalizedEmails = normalizeEmailRows(unwrapped);
    if (normalizedEmails.length > 0) return normalizedEmails;
    if (Array.isArray(unwrapped.emails)) return unwrapped.emails;
    if (Array.isArray(unwrapped.messages)) return unwrapped.messages;
    if (Array.isArray(unwrapped.results)) return unwrapped.results;
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
  const lower = intent.toLowerCase();
  if (rows.every((row) => !isRecord(row))) {
    if (/\bsearch term/.test(lower) && rows.every((row) => looksLikePrimitiveLabel(row, 120))) {
      return { verdict: "pass", reason: "search_term_values" };
    }
    if (/\btotal number of reviews\b/.test(lower) && rows.every((row) => typeof row === "number" && Number.isFinite(row))) {
      return { verdict: "pass", reason: "review_count_values" };
    }
    if (/\breviewer/.test(lower) && rows.every((row) => looksLikePrimitiveName(row))) {
      return { verdict: "pass", reason: "reviewer_name_values" };
    }
    return { verdict: "fail", reason: "primitive_rows" };
  }

  const objects = rows.filter(isRecord);
  if (objects.length === 0) return { verdict: "fail", reason: "primitive_rows" };

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

  if (/\b(model|models)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["id", "modelId", "name"]) &&
      hasAnyPath(row, ["downloads", "likes", "pipeline_tag", "url"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "model_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(news|story|stories|article|articles|hacker news)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["objectID", "id", "url", "link"]) &&
      hasAnyPath(row, ["title", "story_title", "author", "points", "num_comments", "meta"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "story_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
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
    const aggregated = objects.filter((row) =>
      hasAnyPath(row, ["username", "post_author", "submission_author"]) &&
      hasAnyPath(row, ["post_title", "submission_title", "title"]) &&
      hasAnyPath(row, ["count"])
    );
    if (aggregated.length >= 1 && /\bpost title\b/.test(lower) && /\busername\b/.test(lower) && /\bcount the number of comments\b/.test(lower)) {
      return { verdict: "pass", reason: "comment_aggregate_rows" };
    }
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["id", "url", "permalink"]) &&
      hasAnyPath(row, ["author", "body", "text"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "comment_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(email|emails|mail|inbox)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["id", "thread.doc_id", "matchedEmail.id"]) &&
      hasAnyPath(row, ["subject", "thread.subject", "from", "sender", "thread.latest_sender_name"]) &&
      hasAnyPath(row, ["date", "thread.formatted_date", "preview", "thread.preview", "matchedEmail.content_markdown"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "email_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (isFeedPostIntent(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["id", "url", "uri", "permalink"]) &&
      countMatchingGroups(row, [
        ["content", "text", "title", "body"],
        ["account.username", "account.acct", "username", "author", "user.name"],
        ["score", "points", "likes", "favorite_count", "num_comments", "reply_count"],
        ["date", "created_at", "published_at", "timestamp", "meta"],
      ]) >= 2
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

  if (/\b(doc|docs|documentation)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["title", "name", "slug"]) &&
      hasAnyPath(row, ["url", "link", "href", "mdn_url"]) &&
      hasAnyPath(row, ["summary", "description", "slug", "popularity", "score"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "document_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(paper|papers)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["title", "name"]) &&
      hasAnyPath(row, ["url", "link", "href"]) &&
      hasAnyPath(row, ["summary", "description", "author", "authors", "date", "published", "meta"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "paper_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(question|questions)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["title", "name"]) &&
      hasAnyPath(row, ["url", "link", "href", "permalink"]) &&
      countMatchingGroups(row, [
        ["votes", "score", "points"],
        ["answers", "answer_count", "num_answers", "num_comments"],
        ["author", "date", "created_at", "meta"],
      ]) >= 2
    );
    return matching.length >= 2 ? { verdict: "pass", reason: "question_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(recipe|recipes)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["title", "name"]) &&
      hasAnyPath(row, ["url", "link", "href"]) &&
      hasAnyPath(row, ["rating", "review_count", "author", "description", "summary", "cook_time", "total_time"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "recipe_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(module|modules|timetable|schedule|semester|semesters|lesson|lessons|class|classes)\b/.test(lower)) {
    const moduleRows = objects.filter((row) =>
      hasAnyPath(row, ["moduleCode", "module.code", "code"]) &&
      hasAnyPath(row, ["title", "name"]) &&
      (Array.isArray(getPath(row, "semesters")) || hasAnyPath(row, ["semester"]))
    );
    if (moduleRows.length >= 1) return { verdict: "pass", reason: "module_rows" };

    const timetableRows = objects.filter((row) =>
      hasAnyPath(row, ["moduleCode", "classNo", "lessonType", "title", "name"]) &&
      countMatchingGroups(row, [
        ["semester", "semesters", "lessonType", "classNo"],
        ["day", "dayText", "startTime", "endTime", "venue"],
      ]) >= 2
    );
    return timetableRows.length >= 1 ? { verdict: "pass", reason: "timetable_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(course|courses)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["title", "name"]) &&
      hasAnyPath(row, ["url", "link", "href"]) &&
      hasAnyPath(row, ["rating", "partner", "provider", "instructor", "description", "summary", "duration", "level"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "course_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(definition|dictionary|meaning)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["term", "title", "name", "word"]) &&
      hasAnyPath(row, ["definition", "summary", "body", "description"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "definition_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(stock|stocks|ticker|tickers|quote|quotes)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["symbol", "ticker"]) &&
      hasAnyPath(row, ["price", "regularMarketPrice", "current_price"]) &&
      hasAnyPath(row, ["name", "currency", "change_percent", "market_cap", "market_state"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "quote_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(product|products|item|items)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["title", "name", "product_name"]) &&
      (
        hasAnyPath(row, ["url", "id", "product_id", "sku"]) ||
        hasAnyPath(row, ["description", "summary"])
      ) &&
      hasAnyPath(row, ["price", "rating", "review_count", "brand", "image"]) &&
      !/^results?$/i.test(String(getPath(row, "title") ?? getPath(row, "name") ?? "")) &&
      !Object.keys(row).some((key) => /^heading_\d+$/i.test(key)) &&
      !/(amazon-adsystem|doubleclick|googlesyndication|pubmatic|taboola|outbrain|aax-|googleadservices|adservice)/i.test(
        String(getPath(row, "url") ?? ""),
      )
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "product_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(channel|channels|server|servers|guild|guilds|workspace|workspaces)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["name", "title"]) &&
      hasAnyPath(row, ["id", "url", "channel_id", "guild_id", "workspace_id"]) &&
      hasAnyPath(row, ["description", "type", "member_count", "url"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "channel_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
  }

  if (/\b(search|find|lookup)\b/.test(lower)) {
    const matching = objects.filter((row) =>
      hasAnyPath(row, ["name", "title", "songName", "resource_name"]) &&
      hasAnyPath(row, ["id", "url", "link", "href", "resource_id", "citation", "case_number"]) &&
      hasAnyPath(row, ["description", "summary", "metadata", "stats", "author", "uploader", "createdAt", "updatedAt", "court", "decision_date", "coram", "catchword"])
    );
    return matching.length >= 1 ? { verdict: "pass", reason: "search_rows" } : { verdict: "fail", reason: "wrong_entity_type" };
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
    const lower = (intent ?? "").toLowerCase();
    if (("message" in projected || "flash" in projected) && !("data" in projected)) {
      if (/\b(message|messages|flash|alert|success|error|warning)\b/.test(lower)) {
        return { verdict: "skip", reason: "message_record", projected };
      }
      return { verdict: "fail", reason: "message_only", projected };
    }
    if (/\b(company|companies|organization|organisations|business|person|people|profile|profiles|member|members|user|users|repo|repository|repositories|project|projects|package|packages|doc|docs|documentation|question|questions|recipe|recipes|course|courses|definition|dictionary|meaning|product|products|item|items|stock|stocks|ticker|tickers|quote|quotes|channel|channels|server|servers|guild|guilds|workspace|workspaces)\b/.test(lower) || isFeedPostIntent(lower)) {
      const classified = classifyRows([projected], intent ?? "");
      return { ...classified, projected };
    }
  }

  return { verdict: "skip", reason: "unclassified_payload", projected };
}
