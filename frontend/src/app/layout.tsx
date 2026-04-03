import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/lib/auth-context";
import { Navbar } from "@/components/navbar";
import { DocsEmbed } from "@/components/docs-embed";
import versionInfo from "../../../version.json";
import "./globals.css";

export const metadata: Metadata = {
  title: "Unbrowse — Drop-in replacement for browser automation in agent stacks",
  description:
    "Unbrowse is a drop-in replacement for browser automation in agent stacks. It learns the request path behind websites so agents run faster, cheaper, and with less breakage than repeated browser rediscovery.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  alternates: {
    canonical: "https://www.unbrowse.ai",
  },
  openGraph: {
    title: "Unbrowse — Drop-in replacement for browser automation in agent stacks",
    description:
      "Unbrowse is a drop-in replacement for browser automation in agent stacks. It learns the request path behind websites so agents run faster, cheaper, and with less breakage than repeated browser rediscovery.",
    url: "https://www.unbrowse.ai",
    siteName: "Unbrowse",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        width: 1200,
        height: 630,
        alt: "Unbrowse — Drop-in replacement for browser automation in agent stacks",
      },
      {
        url: "https://www.unbrowse.ai/nvidia-inception.png",
        alt: "Unbrowse in NVIDIA Inception",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@getFoundry",
    title: "Unbrowse — Drop-in replacement for browser automation in agent stacks",
    description:
      "Unbrowse is a drop-in replacement for browser automation in agent stacks. It learns the request path behind websites so agents run faster, cheaper, and with less breakage than repeated browser rediscovery.",
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
  other: {
    "ai-skill": "https://www.unbrowse.ai/skill.md",
    "ai-plugin": "https://www.unbrowse.ai/.well-known/ai-plugin.json",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="alternate" type="text/markdown" href="/skill.md" title="Agent Skill Documentation" />
        <link rel="alternate" type="text/plain" href="/llms.txt" title="LLM Site Information" />
        <link
          rel="preconnect"
          href="https://fonts.googleapis.com"
        />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link rel="preconnect" href="https://cloud.umami.is" />
          <link
            href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Google+Sans+Display:wght@400;500;700&display=swap"
            rel="stylesheet"
          />
        <style>{`
          :root {
            --font-jetbrains-mono: ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
            --font-google-sans: 'Google Sans', 'Google Sans Display', system-ui, sans-serif;
            --font-fonetika: 'Fonetika', 'Google Sans', system-ui, sans-serif;
          }
        `}</style>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "Unbrowse",
              legalName: "Unbrowse AI PTE. LTD.",
              url: "https://www.unbrowse.ai",
              logo: "https://www.unbrowse.ai/logo.png",
              description:
                "Unbrowse is a drop-in replacement for browser automation in agent stacks. It turns repeated browser work into reusable learned routes for AI agents.",
              foundingDate: "2026",
              foundingLocation: {
                "@type": "Place",
                name: "Singapore",
              },
              sameAs: [
                "https://github.com/unbrowse-ai",
                "https://github.com/unbrowse-ai/unbrowse",
                "https://x.com/getFoundry",
                "https://www.npmjs.com/package/unbrowse",
                "https://arxiv.org/abs/2604.00694",
              ],
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "Unbrowse",
              description:
                "A drop-in replacement for browser automation in agent stacks. Unbrowse learns the request path behind websites and reuses it as a skill for AI agents.",
              url: "https://www.unbrowse.ai",
              applicationCategory: "DeveloperApplication",
              operatingSystem: "Cross-platform (macOS, Linux, Windows)",
              softwareVersion: versionInfo.version,
              downloadUrl: "https://www.npmjs.com/package/unbrowse",
              codeRepository: "https://github.com/unbrowse-ai/unbrowse",
              isAccessibleForFree: true,
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
              author: {
                "@type": "Organization",
                name: "Unbrowse AI PTE. LTD.",
                url: "https://www.unbrowse.ai",
              },
              featureList: [
                "Drop-in replacement for browser automation in agent stacks",
                "Learns and reuses website request flows as skills",
                "100x faster than headless browsers (50-200ms vs 5-30s)",
                "40x fewer tokens (200 vs 8000 per page)",
                "Shared skill registry for collective API discoveries",
                "Works with Claude Code, Cursor, OpenClaw, and Windsurf",
              ],
              programmingLanguage: "TypeScript",
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "ScholarlyArticle",
              headline: "Internal APIs Are All You Need",
              name: "Internal APIs Are All You Need",
              description:
                "Research paper demonstrating that learned internal request paths can outperform repeated headless browser automation for AI agents.",
              url: "https://arxiv.org/abs/2604.00694",
              author: [
                {
                  "@type": "Person",
                  name: "Lewis Tham",
                },
                {
                  "@type": "Person",
                  name: "Nicholas Mac Gregor Garcia",
                },
                {
                  "@type": "Person",
                  name: "Jungpil Hahn",
                },
              ],
              publisher: {
                "@type": "Organization",
                name: "arXiv",
                url: "https://arxiv.org",
              },
              datePublished: "2026",
              isAccessibleForFree: true,
              sameAs: "https://arxiv.org/abs/2604.00694",
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "FAQPage",
              mainEntity: [
                {
                  "@type": "Question",
                  name: "What is Unbrowse?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Unbrowse is a drop-in replacement for browser automation in agent stacks. It learns the request path behind websites and reuses it as a skill, so agents stop repeating the same browser workflow every time.",
                  },
                },
                {
                  "@type": "Question",
                  name: "How does Unbrowse work?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Unbrowse can use a real browser on the first pass to learn the request flow behind a site, then reuse that learned route as a skill on later runs. The browser stays available for auth and hard cases, but repeat work stops depending on the DOM.",
                  },
                },
                {
                  "@type": "Question",
                  name: "Which AI coding agents work with Unbrowse?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Unbrowse works with all major AI coding agents including Claude Code, Cursor, OpenClaw, and Windsurf. The simplest full install path is curl -fsSL https://unbrowse.ai/install.sh | bash. After install, hosts with skills support can also use npx skills add unbrowse-ai/unbrowse.",
                  },
                },
                {
                  "@type": "Question",
                  name: "Is Unbrowse free to use?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Yes, Unbrowse is free and open-source. Install it with curl -fsSL https://unbrowse.ai/install.sh | bash and start discovering APIs immediately. After install, hosts with skills support can also use npx skills add unbrowse-ai/unbrowse. The shared skill marketplace lets you benefit from APIs discovered by the community.",
                  },
                },
              ],
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Unbrowse",
              url: "https://www.unbrowse.ai",
              potentialAction: {
                "@type": "SearchAction",
                target: {
                  "@type": "EntryPoint",
                  urlTemplate:
                    "https://www.unbrowse.ai/search?q={search_term_string}",
                },
                "query-input": "required name=search_term_string",
              },
            }),
          }}
        />
        <script defer src="https://cloud.umami.is/script.js" data-website-id="66d811d2-a320-4b38-87b9-b15a60022313"></script>
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <AuthProvider>
            <Navbar />
            <main className="min-h-screen">
              {children}
            </main>
            <DocsEmbed />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
