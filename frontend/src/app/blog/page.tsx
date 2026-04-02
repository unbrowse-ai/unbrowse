import type { Metadata } from "next";
import Link from "next/link";
import { listAllBlogPosts } from "@/lib/blog/server";

export const metadata: Metadata = {
  title: "Blog | Unbrowse",
  description:
    "Articles on shadow APIs, browser automation, agent economics, and the agentic web from the Unbrowse team.",
  alternates: {
    canonical: "https://www.unbrowse.ai/blog",
  },
  openGraph: {
    title: "Blog | Unbrowse",
    description:
      "Articles on shadow APIs, browser automation, agent economics, and the agentic web from the Unbrowse team.",
    url: "https://www.unbrowse.ai/blog",
    siteName: "Unbrowse",
    type: "website",
  },
};

export default async function BlogIndexPage() {
  const posts = await listAllBlogPosts();

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <header className="mb-12 border-b border-border pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.25em] text-orange-600 mb-4">
            Blog
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight">
            Articles
          </h1>
          <p className="mt-4 text-xl text-text-secondary font-medium">
            Shadow APIs, browser automation, agent economics, and the agentic
            web.
          </p>
        </header>

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
                className="block group rounded-2xl border border-border bg-surface-raised p-6 sm:p-8 hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
              >
                <div className="flex items-center gap-3 mb-3">
                  {post.category && (
                    <span className="text-xs font-mono font-medium uppercase tracking-[0.2em] text-orange-600">
                      {post.category}
                    </span>
                  )}
                  {formattedDate && (
                    <span className="text-xs text-text-muted">
                      {formattedDate}
                    </span>
                  )}
                </div>
                <h2 className="text-xl sm:text-2xl font-semibold tracking-tight group-hover:text-orange-600 transition-colors">
                  {post.title}
                </h2>
                {post.description && (
                  <p className="mt-2 text-base text-text-secondary line-clamp-2">
                    {post.description}
                  </p>
                )}
                {post.author && (
                  <p className="mt-3 text-sm text-text-muted">
                    {post.author}
                  </p>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
