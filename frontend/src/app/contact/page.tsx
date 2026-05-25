import type { Metadata } from "next";
import Link from "next/link";

const CANONICAL = "https://www.unbrowse.ai/contact";
const TITLE = "Contact Unbrowse — support, security disclosure, partnerships";
const DESCRIPTION =
  "Get in touch with Unbrowse AI Pte. Ltd. — support@unbrowse.ai for general questions, security@unbrowse.ai for vulnerability disclosure, Discord for real-time community help, GitHub for issues and PRs.";

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: CANONICAL,
    siteName: "Unbrowse",
    type: "website",
    images: [{ url: "https://www.unbrowse.ai/og-image.png", alt: "Unbrowse — contact" }],
  },
};

export default function ContactPage() {
  const contactPageLd = {
    "@context": "https://schema.org",
    "@type": "ContactPage",
    url: CANONICAL,
    name: TITLE,
    description: DESCRIPTION,
    mainEntity: {
      "@type": "Organization",
      name: "Unbrowse",
      legalName: "Unbrowse AI Pte. Ltd.",
      url: "https://www.unbrowse.ai",
      contactPoint: [
        {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: "support@unbrowse.ai",
          availableLanguage: ["en"],
        },
        {
          "@type": "ContactPoint",
          contactType: "security",
          email: "security@unbrowse.ai",
          url: "https://www.unbrowse.ai/security",
        },
        {
          "@type": "ContactPoint",
          contactType: "sales",
          email: "hello@unbrowse.ai",
        },
      ],
      address: {
        "@type": "PostalAddress",
        addressCountry: "SG",
        addressLocality: "Singapore",
      },
    },
  };

  return (
    <div className="max-w-3xl mx-auto px-6 pt-28 pb-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(contactPageLd) }} />

      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-orange-500 transition-colors mb-8"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </Link>

      <h1 className="text-4xl font-bold tracking-tight mb-3 animate-fade-up">Contact</h1>
      <p className="text-text-secondary text-lg mb-10 leading-relaxed animate-fade-up stagger-1">
        Four channels — pick the one closest to your question. We answer faster on Discord than email; we
        answer security email faster than anything else.
      </p>

      <div className="grid gap-4 mb-12">
        <ContactCard
          label="General support"
          value="support@unbrowse.ai"
          href="mailto:support@unbrowse.ai"
          hint="Setup, billing, account questions. Reply within 1–2 business days."
        />
        <ContactCard
          label="Security disclosure"
          value="security@unbrowse.ai"
          href="mailto:security@unbrowse.ai"
          hint="Responsible disclosure under a 90-day window. See /security for scope and PGP key."
          accent
        />
        <ContactCard
          label="Sales / partnerships"
          value="hello@unbrowse.ai"
          href="mailto:hello@unbrowse.ai"
          hint="Fleet operators, enterprise deployments, marketplace listings."
        />
        <ContactCard
          label="Community"
          value="discord.gg/VWugEeFNsG"
          href="https://discord.gg/VWugEeFNsG"
          hint="Real-time discussion, release pings, agent operators sharing recipes."
        />
      </div>

      <section className="mb-12">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## GitHub
        </h2>
        <ul className="space-y-2 text-sm text-text-secondary">
          <li>
            Issues and PRs:{" "}
            <a
              href="https://github.com/unbrowse-ai/unbrowse/issues"
              target="_blank"
              rel="noopener"
              className="text-orange-500 hover:underline"
            >
              github.com/unbrowse-ai/unbrowse
            </a>
          </li>
          <li>
            Discussions:{" "}
            <a
              href="https://github.com/unbrowse-ai/unbrowse/discussions"
              target="_blank"
              rel="noopener"
              className="text-orange-500 hover:underline"
            >
              github.com/unbrowse-ai/unbrowse/discussions
            </a>
          </li>
        </ul>
      </section>

      <section className="border-t border-border pt-8">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## Company
        </h2>
        <p className="text-sm text-text-secondary leading-relaxed">
          <strong className="text-text-primary">Unbrowse AI Pte. Ltd.</strong>
          <br />
          Singapore
          <br />
          See <Link href="/about" className="text-orange-500 hover:underline">/about</Link> for team, research, and recognition.
        </p>
      </section>
    </div>
  );
}

function ContactCard({
  label,
  value,
  href,
  hint,
  accent,
}: {
  label: string;
  value: string;
  href: string;
  hint: string;
  accent?: boolean;
}) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener" } : {})}
      className="block border rounded-md p-5 transition-colors hover:bg-orange-50"
      style={{
        borderColor: accent ? "rgba(255,122,32,0.45)" : "rgba(255,122,32,0.18)",
        background: accent ? "rgba(255,122,32,0.06)" : "transparent",
      }}
    >
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-orange-500">
          {label}
        </span>
        {accent && (
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[rgba(108,255,175,0.85)]">
            priority
          </span>
        )}
      </div>
      <div className="text-base font-mono text-text-primary mb-1">{value}</div>
      <p className="text-xs text-text-secondary leading-relaxed">{hint}</p>
    </a>
  );
}
