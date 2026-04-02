import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getBlogPost } from "@/lib/blog/server";
import { renderBlogMarkdown } from "@/lib/blog/markdown";
import { ArticleShell } from "@/components/blog/article-shell";
import { LEGACY_BLOG_POSTS } from "@/lib/blog/legacy-posts";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// ---------------------------------------------------------------------------
// Metadata (uses React cache — same fetch as the page render)
// ---------------------------------------------------------------------------

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const legacyPost = LEGACY_BLOG_POSTS.find((post) => post.slug === slug);
  if (legacyPost) {
    return {
      title: `${legacyPost.title} | Unbrowse Blog`,
      description: legacyPost.description,
      alternates: {
        canonical: `https://www.unbrowse.ai${legacyPost.canonicalPath}`,
      },
    };
  }

  const post = await getBlogPost(slug);
  if (!post) return {};

  const canonical = `https://www.unbrowse.ai/blog/${post.slug}`;

  return {
    title: `${post.title} | Unbrowse Blog`,
    description: post.description,
    alternates: { canonical },
    authors: [{ name: post.author ?? "Lewis Tham" }],
    keywords: post.keywords,
    openGraph: {
      title: post.title,
      description: post.description,
      url: canonical,
      siteName: "Unbrowse",
      type: "article",
      publishedTime: post.published_at,
      images: [
        {
          url: "https://www.unbrowse.ai/og-image.png",
          width: 1200,
          height: 630,
          alt: post.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      site: "@getFoundry",
      title: post.title,
      description: post.description,
      images: ["https://www.unbrowse.ai/og-image.png"],
    },
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const legacyPost = LEGACY_BLOG_POSTS.find((post) => post.slug === slug);
  if (legacyPost) permanentRedirect(legacyPost.canonicalPath);

  const post = await getBlogPost(slug);
  if (!post) notFound();

  const html = renderBlogMarkdown(post.content);

  // JSON-LD Article schema
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.description,
    author: {
      "@type": "Person",
      name: post.author ?? "Lewis Tham",
    },
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: "https://www.unbrowse.ai/logo.png",
    },
    datePublished: post.published_at,
    url: `https://www.unbrowse.ai/blog/${post.slug}`,
    keywords: post.keywords?.join(", "),
    isAccessibleForFree: true,
    inLanguage: "en-US",
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ArticleShell
        title={post.title}
        description={post.description}
        author={post.author ?? "Lewis Tham"}
        date={post.published_at}
        category="Blog"
      >
        <div
          className="blog-markdown"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </ArticleShell>
    </>
  );
}
