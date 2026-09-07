import Link from "next/link";

interface ArticleShellProps {
  title: string;
  description?: string;
  author?: string;
  date?: string;
  category?: string;
  children: React.ReactNode;
}

/**
 * Shared article layout that mirrors the exact Tailwind styling from the
 * internal-apis-are-all-you-need static page.
 */
export function ArticleShell({
  title,
  description,
  author,
  date,
  category,
  children,
}: ArticleShellProps) {
  const formattedDate = date
    ? new Date(date).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : undefined;

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <article className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        {/* Back link */}
        <div className="mb-6">
          <Link
            href="/blog"
            className="text-sm text-orange-600 hover:text-orange-500 transition-colors"
          >
            &larr; All articles
          </Link>
        </div>

        {/* Header */}
        <header className="mb-12 border-b border-border pb-10">
          {category && (
            <p className="text-xs font-mono font-medium uppercase tracking-[0.25em] text-orange-600 mb-4">
              {category}
            </p>
          )}
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight">
            {title}
          </h1>
          {description && (
            <p className="mt-4 text-xl sm:text-2xl text-text-secondary font-medium text-balance">
              {description}
            </p>
          )}
          <div className="mt-8 space-y-1 text-sm sm:text-base text-text-secondary">
            {author && (
              <div className="font-semibold text-text-primary">{author}</div>
            )}
            {formattedDate && <div>{formattedDate}</div>}
          </div>
        </header>

        {/* Body */}
        {children}
      </article>
    </div>
  );
}
