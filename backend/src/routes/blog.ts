import { Hono } from "hono";
import type { Env } from "../types.js";
import { deleteHttpCache, getOrSetHttpCache } from "../services/http-cache.js";
import { statsKVOr503 } from "../services/stats-kv-guard.js";

export const blogRoutes = new Hono<{ Bindings: Env }>();

interface BlogPost {
  slug: string;
  title: string;
  description: string;
  keywords?: string[];
  content: string;
  author?: string;
  published_at?: string;
}

const MAX_BLOG_TITLE = 256;
const MAX_BLOG_DESCRIPTION = 1024;
const MAX_BLOG_CONTENT = 200_000;
const MAX_BLOG_AUTHOR = 128;
const MAX_KEYWORDS = 16;
const MAX_KEYWORD_LEN = 64;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/** Timing-safe string comparison so the publish key check can't be brute-forced. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

blogRoutes.post("/blog/publish", async (c) => {
  // SECURITY: BLOG_PUBLISH_KEY is set via `wrangler secret put`. The previous
  // hardcoded constant was committed to the repo and leaked any time someone
  // pulled CLAUDE.md or browsed unbrowse-dev — see security-reports for the
  // rotation plan.
  const expectedKey = c.env.BLOG_PUBLISH_KEY?.trim();
  if (!expectedKey) {
    console.error("[blog/publish] BLOG_PUBLISH_KEY not configured");
    return c.json({ error: "blog publishing is not configured" }, 503);
  }
  const auth = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const presented = auth.slice(7);
  if (!safeCompare(presented, expectedKey)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await c.req.json<BlogPost>();
  if (typeof body?.slug !== "string" || typeof body?.title !== "string" || typeof body?.content !== "string") {
    return c.json({ error: "slug, title, and content are required strings" }, 400);
  }
  if (body.title.length === 0 || body.title.length > MAX_BLOG_TITLE) {
    return c.json({ error: `title must be 1..${MAX_BLOG_TITLE} chars` }, 400);
  }
  if (body.content.length === 0 || body.content.length > MAX_BLOG_CONTENT) {
    return c.json({ error: `content must be 1..${MAX_BLOG_CONTENT} chars` }, 400);
  }
  if (body.description != null && (typeof body.description !== "string" || body.description.length > MAX_BLOG_DESCRIPTION)) {
    return c.json({ error: `description must be a string up to ${MAX_BLOG_DESCRIPTION} chars` }, 400);
  }
  if (body.author != null && (typeof body.author !== "string" || body.author.length > MAX_BLOG_AUTHOR)) {
    return c.json({ error: `author must be a string up to ${MAX_BLOG_AUTHOR} chars` }, 400);
  }
  if (body.keywords != null && !Array.isArray(body.keywords)) {
    return c.json({ error: "keywords must be an array of strings" }, 400);
  }
  if (Array.isArray(body.keywords)) {
    if (body.keywords.length > MAX_KEYWORDS) {
      return c.json({ error: `keywords must be at most ${MAX_KEYWORDS} entries` }, 400);
    }
    for (const k of body.keywords) {
      if (typeof k !== "string" || k.length === 0 || k.length > MAX_KEYWORD_LEN || CTRL_RE.test(k)) {
        return c.json({ error: "keyword entries must be strings up to 64 chars without control characters" }, 400);
      }
    }
  }
  if (CTRL_RE.test(body.title) || CTRL_RE.test(body.description ?? "") || CTRL_RE.test(body.author ?? "")) {
    return c.json({ error: "title/description/author must not contain control characters" }, 400);
  }

  const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 128);
  if (!slug) {
    return c.json({ error: "slug must contain at least one a-z/0-9/- character" }, 400);
  }

  const post: BlogPost = {
    slug,
    title: body.title,
    description: body.description || "",
    keywords: body.keywords || [],
    content: body.content,
    author: body.author || "Lewis Tham",
    published_at: body.published_at || new Date().toISOString(),
  };

  // A5 silent-500 guard: surface a typed 503 envelope if STATS_KV is not
  // provisioned, instead of crashing in `c.env.STATS_KV.put(...)` below.
  const kvOrRes = statsKVOr503(c, { slug: post.slug });
  if (kvOrRes instanceof Response) return kvOrRes;
  const kv = kvOrRes;

  await kv.put(
    `blog:${post.slug}`,
    JSON.stringify(post),
    { metadata: { title: post.title, published_at: post.published_at } }
  );

  const indexRaw = await kv.get("blog:_index");
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(post.slug)) {
    index.push(post.slug);
    await kv.put("blog:_index", JSON.stringify(index));
  }

  await Promise.all([
    deleteHttpCache(c.env, "blog:posts"),
    deleteHttpCache(c.env, `blog:post:${post.slug}`),
  ]);

  return c.json({ ok: true, slug: post.slug, url: `https://unbrowse.ai/blog/${post.slug}` });
});

blogRoutes.get("/blog/posts", async (c) => {
  // A5 silent-500 guard: surface a typed 503 envelope if STATS_KV is not
  // provisioned, instead of crashing inside the cache callback below.
  const kvOrRes = statsKVOr503(c);
  if (kvOrRes instanceof Response) return kvOrRes;
  const kv = kvOrRes;

  const payload = await getOrSetHttpCache(c.env, "blog:posts", 300, async () => {
    const indexRaw = await kv.get("blog:_index");
    const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];

    const posts = (
      await Promise.all(
        index.map(async (slug) => {
          const raw = await kv.get(`blog:${slug}`);
          if (!raw) return null;
          const post = JSON.parse(raw) as BlogPost;
          return {
            slug: post.slug,
            title: post.title,
            description: post.description,
            author: post.author,
            published_at: post.published_at,
            keywords: post.keywords,
          };
        })
      )
    ).filter(Boolean);

    posts.sort((a, b) => {
      const da = new Date(a!.published_at ?? "").getTime() || 0;
      const db = new Date(b!.published_at ?? "").getTime() || 0;
      return db - da;
    });

    return { posts };
  });

  c.header("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=600");
  return c.json(payload);
});

blogRoutes.get("/blog/posts/:slug", async (c) => {
  const slug = c.req.param("slug");
  // A5 silent-500 guard: surface a typed 503 envelope if STATS_KV is not
  // provisioned, instead of crashing inside the cache callback below.
  const kvOrRes = statsKVOr503(c, { slug });
  if (kvOrRes instanceof Response) return kvOrRes;
  const kv = kvOrRes;

  const payload = await getOrSetHttpCache(c.env, `blog:post:${slug}`, 300, async () => {
    const raw = await kv.get(`blog:${slug}`);
    if (!raw) return { error: "not found" as const };
    return { post: JSON.parse(raw) as BlogPost };
  });
  if ("error" in payload) return c.json({ error: payload.error }, 404);
  c.header("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=600");
  return c.json(payload.post);
});
