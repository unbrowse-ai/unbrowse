import { Hono } from "hono";
import type { Env } from "../types.js";

const BLOG_PUBLISH_KEY = "6A3Q4N_lAdWQUtTs1biZzqZGl4BlPJVau8wB8dLn5W4";

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

blogRoutes.post("/blog/publish", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || auth !== `Bearer ${BLOG_PUBLISH_KEY}`) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await c.req.json<BlogPost>();
  if (!body.slug || !body.title || !body.content) {
    return c.json({ error: "slug, title, and content are required" }, 400);
  }

  const post: BlogPost = {
    slug: body.slug.replace(/[^a-z0-9-]/g, ""),
    title: body.title,
    description: body.description || "",
    keywords: body.keywords || [],
    content: body.content,
    author: body.author || "Lewis Tham",
    published_at: body.published_at || new Date().toISOString(),
  };

  await c.env.STATS_KV.put(
    `blog:${post.slug}`,
    JSON.stringify(post),
    { metadata: { title: post.title, published_at: post.published_at } }
  );

  const indexRaw = await c.env.STATS_KV.get("blog:_index");
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(post.slug)) {
    index.push(post.slug);
    await c.env.STATS_KV.put("blog:_index", JSON.stringify(index));
  }

  return c.json({ ok: true, slug: post.slug, url: `https://unbrowse.ai/blog/${post.slug}` });
});

blogRoutes.get("/blog/posts", async (c) => {
  const indexRaw = await c.env.STATS_KV.get("blog:_index");
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];

  const posts = (
    await Promise.all(
      index.map(async (slug) => {
        const raw = await c.env.STATS_KV.get(`blog:${slug}`);
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

  // Sort by published_at descending (newest first)
  posts.sort((a, b) => {
    const da = new Date(a!.published_at ?? "").getTime() || 0;
    const db = new Date(b!.published_at ?? "").getTime() || 0;
    return db - da;
  });

  return c.json({ posts });
});

blogRoutes.get("/blog/posts/:slug", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.STATS_KV.get(`blog:${slug}`);
  if (!raw) return c.json({ error: "not found" }, 404);
  return c.json(JSON.parse(raw));
});
