interface PublishPayload {
  slug: string;
  title: string;
  description: string;
  keywords?: string[];
  content: string;
  author?: string;
  published_at?: string;
}

function usage() {
  console.log(`Usage:

  bun scripts/publish-blog.ts <file.md> [--slug value] [--description value]
    [--author value] [--published-at YYYY-MM-DD] [--keywords a,b,c]
    [--api-base https://beta-api.unbrowse.ai/v1]

Env:

  UNBROWSE_BLOG_PUBLISH_KEY or BLOG_PUBLISH_KEY   required
  UNBROWSE_BLOG_API_BASE                          optional override
`);
}

function parseArgs(argv: string[]) {
  const args = [...argv];
  const file = args.shift();
  if (!file || file === "--help" || file === "-h") {
    usage();
    process.exit(file ? 0 : 1);
  }

  const out: Record<string, string> = { file };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseMarkdown(raw: string, fallbackSlug: string) {
  const lines = raw.split(/\r?\n/);
  const titleLine = lines.find((line) => line.startsWith("# "));
  if (!titleLine) {
    throw new Error("Markdown must start with a '# Title' heading");
  }

  const title = titleLine.replace(/^#\s+/, "").trim();
  const italicSummary = lines.find((line) => /^\*.+\*$/.test(line.trim()));
  const publishedLine = lines.find((line) => /^Published\s+\d{4}-\d{2}-\d{2}/i.test(line.trim()));

  let description = italicSummary?.trim().replace(/^\*|\*$/g, "").trim() ?? "";
  if (!description) {
    const firstParagraph = raw
      .split(/\n\s*\n/)
      .map((chunk) => chunk.trim())
      .find((chunk) => chunk && !chunk.startsWith("#") && !chunk.startsWith("*") && !chunk.startsWith("Published "));
    description = firstParagraph?.replace(/\s+/g, " ").slice(0, 220) ?? title;
  }

  const publishedAt = publishedLine?.replace(/^Published\s+/i, "").trim();

  return {
    slug: fallbackSlug,
    title,
    description,
    published_at: publishedAt,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.UNBROWSE_BLOG_PUBLISH_KEY ?? process.env.BLOG_PUBLISH_KEY;
  if (!key) {
    throw new Error("Missing UNBROWSE_BLOG_PUBLISH_KEY or BLOG_PUBLISH_KEY");
  }

  const apiBase = args["api-base"] ?? process.env.UNBROWSE_BLOG_API_BASE ?? "https://beta-api.unbrowse.ai/v1";
  const file = args.file;
  const raw = await Bun.file(file).text();
  const fallbackSlug = slugify(args.slug ?? file.split("/").pop()?.replace(/\.md$/i, "") ?? "post");
  const parsed = parseMarkdown(raw, fallbackSlug);

  const payload: PublishPayload = {
    slug: slugify(args.slug ?? parsed.slug),
    title: args.title ?? parsed.title,
    description: args.description ?? parsed.description,
    content: raw,
    author: args.author ?? "Lewis Tham",
    published_at: args["published-at"] ?? parsed.published_at,
    keywords: args.keywords
      ? args.keywords.split(",").map((part) => part.trim()).filter(Boolean)
      : undefined,
  };

  const res = await fetch(`${apiBase}/blog/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Publish failed (${res.status}): ${text}`);
  }

  console.log(text);
}

await main();
