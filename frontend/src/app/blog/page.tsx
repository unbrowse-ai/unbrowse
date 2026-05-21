import type { Metadata } from "next";
import Link from "next/link";
import { listAllBlogPosts } from "@/lib/blog/server";

const CANONICAL = "https://www.unbrowse.ai/blog";
const DESCRIPTION =
  "Articles on shadow APIs, browser automation, agent economics, and the agentic web from the Unbrowse team. Topics: how AI agents call website APIs directly, MCP server architecture, proof-of-indexing, and benchmarks vs Playwright.";

export const metadata: Metadata = {
  title: "Blog | Unbrowse",
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: "Blog | Unbrowse",
    description: DESCRIPTION,
    url: CANONICAL,
    siteName: "Unbrowse",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    site: "@unbrowse",
    title: "Blog | Unbrowse",
    description: DESCRIPTION,
  },
};

export default async function BlogIndexPage() {
  const posts = await listAllBlogPosts();

  // Build a deduplicated category list ordered by first-seen so the
  // category strip matches the visible order of posts below.
  const categories: string[] = [];
  for (const post of posts) {
    if (post.category && !categories.includes(post.category)) {
      categories.push(post.category);
    }
  }

  // Blog schema gives AI search engines a single object to cite when the
  // intent is "what does Unbrowse write about". The blogPost children
  // are emitted with stable URLs so crawlers can follow into the
  // individual TechArticle nodes already declared on each post page.
  const blogSchema = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "Unbrowse Blog",
    description: DESCRIPTION,
    url: CANONICAL,
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
    },
    blogPost: posts.slice(0, 20).map((post) => ({
      "@type": "BlogPosting",
      headline: post.title,
      url: `https://www.unbrowse.ai${post.href}`,
      datePublished: post.published_at,
      ...(post.author ? { author: { "@type": "Person", name: post.author } } : {}),
      ...(post.description ? { description: post.description } : {}),
    })),
  };

  return (
    <div className="bg-background min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogSchema) }}
      />
      <div className="max-w-4xl mx-auto px-6 py-16 sm:py-24">
        <header className="mb-12 border-b border-[rgba(255,122,32,0.18)] pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.3em] text-orange-500/90 mb-4">
            ##  BLOG
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight">
            Articles
          </h1>
          <p className="mt-5 text-lg sm:text-xl font-mono text-text-secondary leading-relaxed max-w-3xl">
            Shadow APIs, browser automation, agent economics, and the
            agentic web — written by the Unbrowse team while shipping the
            project. Most posts cite the underlying paper (
            <Link
              href="/internal-apis-are-all-you-need"
              className="text-orange-500 underline-offset-4 hover:underline"
            >
              Internal APIs Are All You Need
            </Link>
            ) or benchmark data measured against the 94-domain corpus.
          </p>

          {categories.length > 0 && (
            <nav
              aria-label="Article categories"
              className="mt-7 flex flex-wrap gap-2"
            >
              {categories.map((category) => (
                <span
                  key={category}
                  className="inline-flex items-center px-3 py-1 rounded-sm bg-[#070503]/85 border border-[rgba(255,122,32,0.22)] text-xs font-mono uppercase tracking-[0.18em] text-[rgba(255,176,96,0.85)]"
                >
                  {category}
                </span>
              ))}
            </nav>
          )}
        </header>

        {posts.length === 0 ? (
          <p className="text-text-secondary font-mono text-sm">
            No articles published yet. Check back soon.
          </p>
        ) : (
          <div className="space-y-8">
            {posts.map((post) => {
              const formattedDate = post.published_at
                ? new Date(post.published_at).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })
                : undefined;

              return (
                <Link
                  key={post.slug}
                  href={post.href}
                  className="block group rounded-sm border border-[rgba(255,122,32,0.18)] bg-surface-raised p-6 sm:p-8 hover:border-orange-500/40 hover:bg-orange-50/[0.025] transition-colors"
                >
                  <div className="flex flex-wrap items-center gap-3 mb-3">
                    {post.category && (
                      <span className="text-xs font-mono font-medium uppercase tracking-[0.25em] text-orange-500/90">
                        {post.category}
                      </span>
                    )}
                    {formattedDate && (
                      <span className="text-xs text-text-muted">
                        {formattedDate}
                      </span>
                    )}
                  </div>
                  <h2 className="text-xl sm:text-2xl font-semibold tracking-tight group-hover:text-orange-500 transition-colors">
                    {post.title}
                  </h2>
                  {post.description && (
                    <p className="mt-2 text-base font-mono text-text-secondary line-clamp-2">
                      {post.description}
                    </p>
                  )}
                  {post.author && (
                    <p className="mt-3 text-sm font-mono text-text-muted">
                      {post.author}
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
