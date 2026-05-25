import type { Metadata } from "next";
import { ArticleShell } from "@/components/blog/article-shell";
import { renderBlogMarkdown } from "@/lib/blog/markdown";

const TITLE = "How Unbrowse Turns One Browse Into a Reusable Route";
const DESCRIPTION =
  "A short walkthrough of how a page visit becomes a ranked route, an executable call, and a reusable entry for the next agent.";
const PUBLISHED_AT = "2026-05-25";
const CANONICAL = "https://www.unbrowse.ai/blog/contract-organ-explained";

const BODY = `
Most agents still treat a website as a screen. They open the page, wait for JavaScript, scrape text, and repeat that work the next time another agent asks for the same thing.

Unbrowse treats the page visit as the beginning of a reusable workflow.

## 1. Visit the page once

An agent starts with a normal request: search a marketplace, read a profile, check an order, list a set of results. Unbrowse opens the page only when it has to, using the user's existing browser state when authentication is needed.

While the page loads, Unbrowse watches the requests the site already makes behind the interface. Modern websites rarely put the real data in the HTML. They ask their own JSON routes for it.

## 2. Keep the useful route

Not every request matters. Analytics pings, image loads, ad calls, and error-shaped responses are filtered out. The useful candidates keep the evidence an agent needs later: URL, method, sample fields, required inputs, returned fields, and a short description.

That evidence is the important part. The next agent does not need the previous page body. It needs a callable route with enough context to decide whether it matches the task.

## 3. Return choices, not guesses

When an agent asks for something later, Unbrowse returns a ranked shortlist. The agent reads the evidence, picks the route that matches the user's intent, and calls it.

This is deliberately a two-step flow: resolve, then execute. Auto-running the first match would be fast, but it would also make the wrong call whenever two routes look similar. The agent should choose with evidence in view.

## 4. Reuse the result

After a route works, it becomes part of the shared route graph. The next matching task can skip the browser and call the route directly. If the route changes, the evidence and execution trace show what drifted, so the fix can target the broken link instead of rebuilding the whole workflow.

The result is simple: one browse can become many future API calls.
`;

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse Blog`,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: CANONICAL,
    siteName: "Unbrowse",
    type: "article",
    publishedTime: PUBLISHED_AT,
  },
  twitter: {
    card: "summary_large_image",
    site: "@unbrowse",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function ContractOrganExplainedPage() {
  const html = renderBlogMarkdown(BODY);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: TITLE,
    description: DESCRIPTION,
    author: {
      "@type": "Person",
      name: "Lewis Tham",
    },
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: "https://www.unbrowse.ai/logo.png",
    },
    datePublished: PUBLISHED_AT,
    url: CANONICAL,
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
        title={TITLE}
        description={DESCRIPTION}
        author="Lewis Tham"
        date={PUBLISHED_AT}
        category="Guide"
      >
        <div
          className="blog-markdown"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </ArticleShell>
    </>
  );
}
