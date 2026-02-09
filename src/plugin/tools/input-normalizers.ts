export function normalizeUrlList(urls: unknown): string[] {
  if (typeof urls === "string") return [urls];
  if (Array.isArray(urls)) return urls.filter((u) => typeof u === "string") as string[];
  return [];
}

export function coalesceDir(opts: {
  outputDir?: unknown;
  skillsDir?: unknown;
  fallback: string;
}): string {
  const out = typeof opts.outputDir === "string" ? opts.outputDir : undefined;
  const skills = typeof opts.skillsDir === "string" ? opts.skillsDir : undefined;
  return out ?? skills ?? opts.fallback;
}

