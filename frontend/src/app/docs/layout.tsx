import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Docs — Unbrowse",
  description: "Use Unbrowse from any language. Three lines to your first call.",
  alternates: { canonical: "https://www.unbrowse.ai/docs" },
};

const sections = [
  { href: "/docs", label: "Quickstart" },
  { href: "/docs/api", label: "API reference" },
  { href: "/docs/proxy", label: "Worker proxy + IProyal" },
  { href: "/docs/errors", label: "Errors" },
  { href: "/docs/benchmarks", label: "Benchmarks" },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-10 px-6 py-12 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <nav aria-label="Docs navigation" className="space-y-1 text-sm">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            @unbrowse/client
          </p>
          {sections.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="block rounded-md px-3 py-2 text-foreground/80 transition hover:bg-muted/60 hover:text-foreground"
            >
              {s.label}
            </Link>
          ))}
        </nav>
      </aside>
      <article className="prose prose-neutral max-w-none dark:prose-invert prose-pre:rounded-md prose-pre:border prose-pre:bg-muted/50">
        {children}
      </article>
    </div>
  );
}
