import Link from "next/link";

export const metadata = {
  title: "Terms of Service — unbrowse",
  description: "Terms of Service for unbrowse, operated by Unbrowse AI Pte. Ltd..",
};

export default function TermsPage() {
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
        Terms of Service
      </h1>
      <p className="text-text-secondary text-lg mb-12 animate-fade-up stagger-1">
        Effective date: 22 February 2026
      </p>

      <div className="space-y-12 animate-fade-up stagger-2">

        <Section title="1. Who you&apos;re agreeing with">
          <p>
            These Terms of Service (&quot;Terms&quot;) are a legally binding agreement between
            you (&quot;you&quot; or &quot;User&quot;) and <strong>Unbrowse AI Pte. Ltd.</strong>, a
            company incorporated in Singapore (UEN 202425961N)
            (&quot;Company&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;).
          </p>
          <p>
            Unbrowse is a product owned and operated by Unbrowse AI Pte. Ltd.. By
            accessing or using unbrowse — including the website at unbrowse.ai, the
            CLI tool, the API, and the collective skill registry (collectively, the
            &quot;Service&quot;) — you agree to be bound by these Terms. If you do not agree,
            do not use the Service.
          </p>
        </Section>

        <Section title="2. The Service">
          <p>
            Unbrowse provides tools for AI agents and developers to discover, index,
            and replay API endpoints from websites. The Service includes:
          </p>
          <ul>
            <li>The unbrowse CLI and browser extension</li>
            <li>The collective skill registry and API</li>
            <li>The unbrowse.ai website, dashboard, and documentation</li>
          </ul>
          <p>
            We may modify, suspend, or discontinue any part of the Service at any time
            without prior notice.
          </p>
        </Section>

        <Section title="3. Accounts and API keys">
          <p>
            To use certain features, you may register an agent and receive an API key.
            You are responsible for all activity under your API key. Keep it
            confidential. You must notify us immediately if you suspect unauthorized
            use.
          </p>
          <p>
            We may suspend or revoke API keys at our discretion for violations of these
            Terms or abuse of the Service.
          </p>
        </Section>

        <Section title="4. Acceptable use">
          <p>You agree not to:</p>
          <ul>
            <li>Use the Service to violate any applicable law or third-party rights</li>
            <li>Reverse-engineer, decompile, or disassemble the Service itself (the
              underlying platform — not the website APIs you discover through it)</li>
            <li>Interfere with or disrupt the integrity or performance of the Service</li>
            <li>Attempt to gain unauthorized access to systems or data</li>
            <li>Use the Service to launch denial-of-service attacks against any target</li>
            <li>Redistribute or resell access to the Service without our consent</li>
            <li>Submit malicious or deceptive data to the collective skill registry</li>
          </ul>
          <p>
            You are solely responsible for ensuring your use of discovered API
            endpoints complies with the terms of service of the target websites.
            Unbrowse indexes publicly observable API structure; it does not grant you
            rights to use those APIs beyond what the target site permits.
          </p>
        </Section>

        <Section title="5. Contributions to the collective registry">
          <p>
            When you use unbrowse with default settings, discovered API endpoint
            structures (URL patterns, parameter schemas, response shapes) are
            contributed to the shared collective registry. By using the Service, you
            grant us a worldwide, royalty-free, non-exclusive license to use, store,
            and distribute these API structure contributions as part of the Service.
          </p>
          <p>
            You can opt out of collective sharing at any time using{" "}
            <code>--local-only</code> mode. See our{" "}
            <Link href="/privacy" className="text-orange-500 hover:underline">
              Privacy & Data Sharing
            </Link>{" "}
            page for details on what is and is not shared.
          </p>
        </Section>

        <Section title="6. Intellectual property">
          <p>
            The Service, including all software, designs, trademarks, and
            documentation, is owned by Unbrowse AI Pte. Ltd. and protected by
            intellectual property laws. Nothing in these Terms grants you ownership
            of any part of the Service.
          </p>
          <p>
            The unbrowse CLI is released under an open-source license. Your use of
            the open-source components is governed by that license. These Terms govern
            your use of the hosted Service, API, and registry.
          </p>
        </Section>

        <Section title="7. Disclaimer of warranties">
          <p>
            THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES
            OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING BUT NOT
            LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
            PURPOSE, AND NON-INFRINGEMENT.
          </p>
          <p>
            We do not warrant that the Service will be uninterrupted, error-free, or
            secure, or that any discovered API endpoints will remain available or
            function as expected. API structures in the collective registry reflect
            observed behavior and may become outdated.
          </p>
        </Section>

        <Section title="8. Limitation of liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, UNREEL AI PTE LTD AND ITS
            OFFICERS, DIRECTORS, EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY
            INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR
            ANY LOSS OF PROFITS, DATA, USE, OR GOODWILL, ARISING OUT OF OR IN
            CONNECTION WITH YOUR USE OF THE SERVICE.
          </p>
          <p>
            OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS ARISING OUT OF THESE TERMS
            OR THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) THE AMOUNTS YOU PAID
            TO US IN THE TWELVE MONTHS PRECEDING THE CLAIM, OR (B) ONE HUNDRED
            SINGAPORE DOLLARS (SGD 100).
          </p>
        </Section>

        <Section title="9. Indemnification">
          <p>
            You agree to indemnify and hold harmless Unbrowse AI Pte. Ltd., its officers,
            directors, employees, and agents from any claims, damages, losses, or
            expenses (including reasonable legal fees) arising out of your use of the
            Service, violation of these Terms, or infringement of any third-party
            rights.
          </p>
        </Section>

        <Section title="10. Termination">
          <p>
            We may terminate or suspend your access to the Service at any time, for
            any reason, with or without notice. You may stop using the Service at any
            time. Upon termination, your API keys will be revoked and your right to
            use the Service ceases.
          </p>
          <p>
            Sections 6 through 12 survive termination.
          </p>
        </Section>

        <Section title="11. Governing law and disputes">
          <p>
            These Terms are governed by the laws of Singapore. Any dispute arising
            out of or in connection with these Terms shall be subject to the exclusive
            jurisdiction of the courts of Singapore.
          </p>
        </Section>

        <Section title="12. Changes to these Terms">
          <p>
            We may update these Terms from time to time. We will notify you of
            material changes by posting the updated Terms on the Service with a new
            effective date. Your continued use of the Service after such changes
            constitutes acceptance of the updated Terms.
          </p>
        </Section>

        <Section title="13. Contact">
          <p>
            If you have questions about these Terms, contact us
            at{" "}
            <a
              href="https://x.com/getFoundry"
              target="_blank"
              rel="noopener"
              className="text-orange-500 hover:underline"
            >
              @getFoundry
            </a>{" "}
            or open an issue on{" "}
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="text-orange-500 hover:underline"
            >
              GitHub
            </a>.
          </p>
          <p className="text-sm text-text-muted mt-4">
            Unbrowse AI Pte. Ltd.
            <br />
            Singapore
          </p>
        </Section>

      </div>

      <div className="mt-16 pt-8 border-t border-border text-sm text-text-muted">
        Last updated: 22 February 2026
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
