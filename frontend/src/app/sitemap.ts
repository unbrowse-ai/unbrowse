import type { MetadataRoute } from "next";
import { LEGACY_BLOG_POSTS } from "@/lib/blog/legacy-posts";

const API_BASE = "https://beta-api.unbrowse.ai/v1";

interface DynamicPost {
  slug: string;
  title: string;
  description: string;
  published_at?: string;
}

async function fetchDynamicBlogSlugs(): Promise<DynamicPost[]> {
  try {
    const res = await fetch(`${API_BASE}/blog/posts`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { posts: DynamicPost[] };
    return data.posts ?? [];
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = "https://www.unbrowse.ai";

  const dynamicPosts = await fetchDynamicBlogSlugs();
  const legacyEntries: MetadataRoute.Sitemap = LEGACY_BLOG_POSTS
    .filter((post) => !post.draft && post.slug !== "shadow-apis-are-all-you-need")
    .map((post) => ({
      url: `${baseUrl}${post.canonicalPath}`,
      lastModified: new Date(post.published_at),
      changeFrequency: "weekly" as const,
      priority: 0.85,
    }));

  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/blog`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/papers`,
      lastModified: new Date("2026-04-01"),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/search`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: new Date("2026-02-22"),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: new Date("2026-02-22"),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/compare/playwright`,
      lastModified: new Date("2026-04-02"),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/compare/puppeteer`,
      lastModified: new Date("2026-04-02"),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/compare/browser-use`,
      lastModified: new Date("2026-04-02"),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/compare/crawl4ai`,
      lastModified: new Date("2026-04-02"),
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];

  const legacySlugs = new Set(LEGACY_BLOG_POSTS.map((post) => post.slug));
  const dynamicEntries: MetadataRoute.Sitemap = dynamicPosts.map((post) => ({
    url: `${baseUrl}/blog/${post.slug}`,
    lastModified: post.published_at ? new Date(post.published_at) : new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.8,
  })).filter((entry) => {
    const slug = entry.url.split("/").pop();
    return slug ? !legacySlugs.has(slug) : true;
  });

  return [...staticEntries, ...legacyEntries, ...dynamicEntries];
}
