import type { Metadata } from "next";
import Link from "next/link";
import { PapersBehind } from "@/components/papers-behind";

const CANONICAL = "https://www.unbrowse.ai/security";
const TITLE = "Security — vault architecture, scope, and responsible disclosure";
const DESCRIPTION =
  "Unbrowse stores credentials in a local AES-256 vault that never leaves the user's machine. Captured API skills carry no PII. Report vulnerabilities to security@unbrowse.ai under a 90-day responsible-disclosure window.";

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
    images: [{ url: "https://www.unbrowse.ai/og-image.png", alt: "Unbrowse — security disclosure" }],
  },
};

export default function SecurityPage() {
  const webPageLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    url: CANONICAL,
    name: TITLE,
    description: DESCRIPTION,
    isPartOf: { "@type": "WebSite", url: "https://www.unbrowse.ai", name: "Unbrowse" },
    mainEntity: {
      "@type": "Organization",
      name: "Unbrowse",
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "security",
        email: "security@unbrowse.ai",
        availableLanguage: ["en"],
      },
    },
  };

  return (
    <div className="max-w-3xl mx-auto px-6 pt-28 pb-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webPageLd) }} />

      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-orange-500 transition-colors mb-8"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </Link>

      <span className="eyebrow" style={{ display: "block" }}>Security</span>
      <h1 className="text-4xl font-bold tracking-tight mt-3 mb-3 animate-fade-up">Security</h1>
      <p className="text-text-secondary text-lg mb-10 leading-relaxed animate-fade-up stagger-1">
        The short version: <strong className="text-text-primary">your credentials never leave your machine</strong>.
        Captured API routes carry the URL, method, and headers — never your cookies, tokens, or response
        bodies.
      </p>

      <section className="mb-12 animate-fade-up stagger-2">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## When you bind a credential
        </h2>
        <div className="border border-border rounded-md p-5 bg-surface-raised">
          <p className="text-lg text-text-primary leading-relaxed font-medium">
            Your password is locked to this computer and never leaves it. When your
            agent signs in, it proves you have the credential without ever sending
            the credential.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-text-secondary leading-relaxed">
            <li>
              <strong className="text-text-primary">What is bound:</strong> the
              credential is encrypted in your local vault and tied to your key — only
              your machine can unlock it.
            </li>
            <li>
              <strong className="text-text-primary">What never leaves:</strong> the
              secret itself — the actual password, token, or cookie bytes. They stay
              on your machine, full stop.
            </li>
            <li>
              <strong className="text-text-primary">What travels instead:</strong> a
              zero-knowledge proof — math that confirms you hold the credential
              without revealing it. The site sees a valid sign-in; nobody sees your
              secret.
            </li>
          </ul>
          <p className="mt-4 text-xs font-mono text-text-muted leading-relaxed">
            After <code className="text-orange-400">unbrowse auth</code> you see:{" "}
            <span className="text-[rgba(108,255,175,0.85)]">
              credential bound to your key · sealed in local vault
            </span>{" "}
            — never the secret printed back to you.
          </p>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## Vault architecture
        </h2>
        <ul className="space-y-2 text-sm text-text-secondary leading-relaxed">
          <li>
            <strong className="text-text-primary">AES-256-CBC</strong> at rest. The vault lives at{" "}
            <code className="text-orange-400 bg-orange-50 px-1.5 py-0.5 rounded">
              ~/.unbrowse/vault
            </code>{" "}
            and is encrypted with a key derived from the OS keychain (macOS Keychain / libsecret / DPAPI).
          </li>
          <li>
            <strong className="text-text-primary">Local-first</strong>. The CLI never transmits raw cookies,
            tokens, or response bodies to the marketplace. Only route descriptors (method, URL template,
            header names, status code) are shared.
          </li>
          <li>
            <strong className="text-text-primary">Process isolation</strong>. The MCP server runs in your
            user context with no elevated privileges. No daemon, no system-wide install.
          </li>
        </ul>
      </section>

      <section className="mb-12">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## What gets shared
        </h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="border border-[rgba(108,255,175,0.3)] rounded-md p-4 bg-[rgba(108,255,175,0.04)]">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[rgba(108,255,175,0.85)] mb-2">
              shared with marketplace
            </p>
            <ul className="text-sm text-text-secondary space-y-1">
              <li>· Route URL pattern</li>
              <li>· HTTP method</li>
              <li>· Header field names</li>
              <li>· Status code</li>
              <li>· Domain</li>
            </ul>
          </div>
          <div className="border border-[rgba(248,113,113,0.3)] rounded-md p-4 bg-[rgba(248,113,113,0.04)]">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[rgba(252,165,165,0.85)] mb-2">
              never leaves your machine
            </p>
            <ul className="text-sm text-text-secondary space-y-1">
              <li>· Cookies, session tokens</li>
              <li>· Header values</li>
              <li>· Request/response bodies</li>
              <li>· Your personal data</li>
              <li>· Auth credentials</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## Responsible disclosure
        </h2>
        <p className="text-sm text-text-secondary leading-relaxed mb-4">
          Found a vulnerability? Email{" "}
          <a href="mailto:security@unbrowse.ai" className="text-orange-500 hover:underline">
            security@unbrowse.ai
          </a>
          . We follow a <strong className="text-text-primary">90-day disclosure window</strong>: we
          acknowledge within 48 hours, triage within 7 days, patch and credit you in release notes when the
          fix ships.
        </p>
        <ul className="text-sm text-text-secondary space-y-1.5">
          <li>
            · <strong className="text-text-primary">In scope</strong>: the CLI, the MCP server, the public
            marketplace API at <code className="text-orange-400">beta-api.unbrowse.ai</code>, this website.
          </li>
          <li>
            · <strong className="text-text-primary">Out of scope</strong>: third-party sites whose routes
            we&apos;ve captured. Report those to the site owners directly.
          </li>
          <li>
            · <strong className="text-text-primary">Safe harbor</strong>: good-faith research that respects
            the 90-day window will not be pursued legally.
          </li>
        </ul>
      </section>

      <section className="mb-12">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## Audit trail
        </h2>
        <ul className="text-sm text-text-secondary space-y-2">
          <li>
            ·{" "}
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="text-orange-500 hover:underline"
            >
              Source code (MIT)
            </a>{" "}
            — vault implementation auditable in <code className="text-orange-400">src/vault/</code>.
          </li>
          <li>
            ·{" "}
            <a href="/.well-known/security.txt" className="text-orange-500 hover:underline">
              /.well-known/security.txt
            </a>{" "}
            (RFC 9116).
          </li>
          <li>
            · <Link href="/privacy" className="text-orange-500 hover:underline">Privacy policy</Link> · {" "}
            <Link href="/terms" className="text-orange-500 hover:underline">Terms of service</Link>.
          </li>
        </ul>
      </section>

      <PapersBehind theme="zk-privacy" intro="The architecture behind this — one Ed25519 wallet key signing every layer, credentials bound by zero-knowledge proof and revealed only under signature — is laid out in the security paper." />
    </div>
  );
}
