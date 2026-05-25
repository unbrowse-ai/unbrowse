import type { Metadata } from "next";
import Link from "next/link";
import { listAllBlogPosts } from "@/lib/blog/server";

const CANONICAL = "https://www.unbrowse.ai/blog";
const DESCRIPTION =
  "Articles on shadow APIs, browser automation, agent economics, and the agentic web from the Unbrowse team. Topics: how AI agents call website APIs directly, MCP server architecture, proof-of-indexing, and benchmarks vs Playwright.";

const READING_PATH = [
  {
    slug: "internal-apis-are-all-you-need",
    step: "Thesis",
    note: "Why agents should call the routes websites already use.",
  },
  {
    slug: "shadow-apis-explained",
    step: "Mechanism",
    note: "How those hidden routes are found from normal browsing.",
  },
  {
    slug: "contract-organ-explained",
    step: "Workflow",
    note: "How one page visit becomes a route another agent can call.",
  },
  {
    slug: "benchmark-deep-dive",
    step: "Evidence",
    note: "What changed across the 94-domain benchmark.",
  },
  {
    slug: "mcp-is-now-the-default",
    step: "Agent Surface",
    note: "How agent clients use resolve, choose, then execute.",
  },
  {
    slug: "mine-the-internet",
    step: "Contributor Loop",
    note: "How new routes are contributed and reused.",
  },
] as const;

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
  const readingPathPosts = READING_PATH.flatMap((entry) => {
    const post = posts.find((candidate) => candidate.slug === entry.slug);
    return post ? [{ ...entry, post }] : [];
  });

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
    hasPart: {
      "@type": "ItemList",
      name: "Unbrowse Blog Start Here Path",
      itemListElement: readingPathPosts.map((entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: entry.post.title,
        url: `https://www.unbrowse.ai${entry.post.href}`,
      })),
    },
  };

  return (
    <div className="bg-background min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogSchema) }}
      />
      <div className="max-w-4xl mx-auto px-6 py-16 sm:py-24">
        <header className="mb-12 border-b border-border pb-10">
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
                  className="inline-flex items-center px-3 py-1 rounded-sm bg-surface-ink border border-border text-xs font-mono uppercase tracking-[0.18em] text-text-secondary"
                >
                  {category}
                </span>
              ))}
            </nav>
          )}
        </header>

        {readingPathPosts.length > 0 && (
          <section
            aria-labelledby="start-here"
            className="mb-12 border border-border bg-surface-raised p-5 sm:p-6"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-mono font-medium uppercase tracking-[0.24em] text-orange-500/90">
                  Start here
                </p>
                <h2
                  id="start-here"
                  className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight"
                >
                  A six-step path through the work
                </h2>
              </div>
              <p className="max-w-xl text-sm font-mono text-text-secondary">
                Read these first if you want the argument, the mechanism,
                the evidence, and the contributor model in order.
              </p>
            </div>

            <ol className="mt-6 grid gap-3">
              {readingPathPosts.map((entry, index) => (
                <li key={entry.slug}>
                  <Link
                    href={entry.post.href}
                    className="grid gap-3 border border-border bg-background p-4 transition-colors hover:border-orange-500/40 sm:grid-cols-[4.5rem_1fr]"
                  >
                    <div>
                      <span className="block text-xs font-mono uppercase tracking-[0.2em] text-text-muted">
                        Step {index + 1}
                      </span>
                      <span className="mt-1 block text-sm font-medium text-orange-500">
                        {entry.step}
                      </span>
                    </div>
                    <div>
                      <h3 className="text-base sm:text-lg font-semibold tracking-tight">
                        {entry.post.title}
                      </h3>
                      <p className="mt-1 text-sm font-mono text-text-secondary">
                        {entry.note}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        )}

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
                  className="block group rounded-sm border border-border bg-surface-raised p-6 sm:p-8 hover:border-orange-500/40 hover:bg-orange-50/[0.025] transition-colors"
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
