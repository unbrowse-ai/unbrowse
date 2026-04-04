/** A full blog post fetched from the dynamic API. */
export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  content: string;
  author: string;
  published_at: string;
  keywords?: string[];
}

/** Lightweight item returned by the list endpoint (no content body). */
export interface BlogListItem {
  slug: string;
  title: string;
  description: string;
  author?: string;
  published_at?: string;
  keywords?: string[];
}

/** Static article that still lives under its own route in /app. */
export interface LegacyBlogPost {
  slug: string;
  title: string;
  description: string;
  canonicalPath: string;
  published_at: string;
  author: string;
  category?: string;
  draft?: boolean;
}
