import Link from "next/link";

export const metadata = {
  title: "Privacy & Data Sharing — unbrowse",
  description: "What unbrowse collects, what gets shared with the collective index, and what stays on your machine.",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-28 pb-20">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-orange-500 transition-colors mb-8"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </Link>

      <h1 className="text-4xl font-bold tracking-tight mb-3 animate-fade-up">
        Privacy & Data Sharing
      </h1>
      <p className="text-text-secondary text-lg mb-12 animate-fade-up stagger-1">
        The short version: we share <em>website structure</em>, never <em>your stuff</em>.
        <br />
        <span className="text-sm text-text-muted mt-2 inline-block">
          Unbrowse is operated by <strong className="text-text-primary">Unbrowse AI Pte. Ltd.</strong> (Singapore).
          See our <Link href="/terms" className="text-orange-500 hover:underline">Terms of Service</Link>.
        </span>
      </p>

      <div className="space-y-12 animate-fade-up stagger-2">

        {/* What gets shared */}
        <Section title="What gets shared with the collective index">
          <p>
            When you browse a website with unbrowse, the <strong>API structure</strong> of that
            site is automatically indexed into the collective registry. This includes:
          </p>
          <ul>
            <li>API endpoint URLs and HTTP methods (e.g. <code>GET /v6/quote</code>)</li>
            <li>Request and response schemas (parameter names, types, shapes)</li>
            <li>URL patterns and path templates</li>
            <li>Content types and header patterns (not values)</li>
            <li>General endpoint behavior (idempotency, pagination patterns)</li>
          </ul>
          <p>
            Think of it like contributing a map. You&apos;re sharing <em>the shape of the roads</em>,
            not what&apos;s in anyone&apos;s car.
          </p>
        </Section>

        {/* What stays local */}
        <Section title="What never leaves your machine">
          <p>
            Your personal and authentication data is <strong>never shared, uploaded, or transmitted</strong>.
            This includes:
          </p>
          <ul>
            <li>Cookies, session tokens, and auth headers</li>
            <li>API keys, bearer tokens, and credentials</li>
            <li>Usernames, passwords, and account information</li>
            <li>Request/response bodies containing personal data</li>
            <li>Any data you send to or receive from APIs</li>
            <li>Your browsing history and session recordings</li>
          </ul>
          <p>
            Credentials are stored in a local encrypted vault on your machine. When you replay
            a skill, your auth is injected locally — it never passes through our servers.
          </p>
        </Section>

        {/* Telemetry */}
        <Section title="Telemetry">
          <p>
            Unbrowse collects anonymous usage telemetry to improve the product. This includes:
          </p>
          <ul>
            <li>Which skills are replayed and how often (aggregate counts, not per-user)</li>
            <li>Replay success/failure rates per endpoint</li>
            <li>Skill discovery and indexing events (what domains, not who)</li>
            <li>Error types and crash reports (no personal context)</li>
            <li>Client version and platform (OS, runtime)</li>
          </ul>
          <p>
            Telemetry is used to calculate reliability scores, route agents to the best
            endpoints, and prioritize improvements. It is never sold or shared with third parties.
          </p>
        </Section>

        {/* Not personal data */}
        <Section title="This isn&apos;t about personal data">
          <p>
            To be clear: unbrowse does not collect, process, or store personal data as defined by
            GDPR, CCPA, or similar regulations. The data shared with the collective index is
            <strong> website infrastructure information</strong> — the same endpoint structures
            any developer could discover by opening browser DevTools.
          </p>
          <p>
            We&apos;re indexing how websites work, not who uses them.
          </p>
        </Section>

        {/* Opt out */}
        <Section title="Opting out">
          <p>
            You can disable telemetry at any time:
          </p>
          <div className="bg-surface-raised border border-border rounded-xl p-4 font-mono text-sm text-text-secondary">
            <code>unbrowse config set telemetry false</code>
          </div>
          <p>
            You can also run unbrowse in local-only mode, which skips indexing to the shared
            registry entirely. Skills you discover stay on your machine.
          </p>
          <div className="bg-surface-raised border border-border rounded-xl p-4 font-mono text-sm text-text-secondary">
            <code>unbrowse --local-only jup.ag</code>
          </div>
        </Section>

        {/* Contact */}
        <Section title="Questions?">
          <p>
            If you have questions about what data unbrowse handles, reach out
            at <a href="https://x.com/getFoundry" target="_blank" rel="noopener" className="text-orange-500 hover:underline">@getFoundry</a> or
            open an issue on <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener" className="text-orange-500 hover:underline">GitHub</a>.
          </p>
          <p className="text-sm text-text-muted mt-2">
            Unbrowse AI Pte. Ltd. &middot; Singapore
          </p>
        </Section>

      </div>

      <div className="mt-16 pt-8 border-t border-border text-sm text-text-muted">
        Last updated: February 2026
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-bold mb-4">{title}</h2>
      <div className="space-y-4 text-text-secondary leading-relaxed
                      [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-2
                      [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:bg-surface-raised
                      [&_code]:border [&_code]:border-border [&_code]:rounded [&_code]:text-sm [&_code]:font-mono
                      [&_strong]:text-text-primary [&_em]:text-text-primary">
        {children}
      </div>
    </section>
  );
}
