import "server-only";

import { cache } from "react";
import { getConfiguredApiV1Origin } from "@/lib/api-base";
import { fetchWithTimeout } from "@/lib/server-fetch";
import type { BlogPost, BlogListItem } from "./types";
import { LEGACY_BLOG_POSTS } from "./legacy-posts";

const API_BASE = getConfiguredApiV1Origin();

// ---------------------------------------------------------------------------
// Single post
// ---------------------------------------------------------------------------

export const getBlogPost = cache(
  async (slug: string): Promise<BlogPost | null> => {
    try {
      const res = await fetchWithTimeout(
        `${API_BASE}/blog/posts/${encodeURIComponent(slug)}`,
        { next: { revalidate: 300 } }
      );
      if (!res.ok) return null;
      return (await res.json()) as BlogPost;
    } catch {
      return null;
    }
  }
);

// ---------------------------------------------------------------------------
// Dynamic post list (from API)
// ---------------------------------------------------------------------------

export const listDynamicBlogPosts = cache(async (): Promise<BlogListItem[]> => {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/blog/posts`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { posts: BlogListItem[] };
    return data.posts ?? [];
  } catch {
    return [];
  }
});

// ---------------------------------------------------------------------------
// Merged list: legacy manifest + dynamic posts, newest first
// ---------------------------------------------------------------------------

export const listAllBlogPosts = cache(async () => {
  const dynamic = await listDynamicBlogPosts();

  // Build a unified array with a `source` discriminator so the UI knows how
  // to link each entry (legacy posts live at /<slug>, dynamic at /blog/<slug>).
  const legacyItems = LEGACY_BLOG_POSTS
    .filter((p) => !p.draft)
    .map((p) => ({
      slug: p.slug,
      title: p.title,
      description: p.description,
      author: p.author,
      published_at: p.published_at,
      category: p.category,
      source: "legacy" as const,
      href: p.canonicalPath,
    }));

  const dynamicItems = dynamic.map((p) => ({
    slug: p.slug,
    title: p.title,
    description: p.description,
    author: p.author ?? "Lewis Tham",
    published_at: p.published_at ?? new Date().toISOString(),
    category: undefined as string | undefined,
    source: "dynamic" as const,
    href: `/blog/${p.slug}`,
  }));

  const all: Array<(typeof legacyItems)[number] | (typeof dynamicItems)[number]> = [...legacyItems];

  // Static routes are the current canonical source for legacy articles.
  // If someone later publishes the same slug via the dynamic API, keep the
  // legacy entry in the blog index to avoid duplicate crawl targets.
  for (const item of dynamicItems) {
    if (!all.some((existing) => existing.slug === item.slug)) {
      all.push(item);
    }
  }

  // Sort newest first
  all.sort((a, b) => {
    const da = new Date(a.published_at).getTime();
    const db = new Date(b.published_at).getTime();
    return db - da;
  });

  return all;
});
