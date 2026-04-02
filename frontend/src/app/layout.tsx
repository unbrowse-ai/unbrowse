import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/lib/auth-context";
import { Navbar } from "@/components/navbar";
import { DocsEmbed } from "@/components/docs-embed";
import "./globals.css";

export const metadata: Metadata = {
  title: "Unbrowse — Reverse-engineer any website into API skills for AI agents",
  description:
    "Stop automating headless browsers. Unbrowse reverse-engineers website APIs so AI agents make direct calls. 100x faster, 40x fewer tokens.",
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
    title: "Unbrowse — Reverse-engineer any website into API skills for AI agents",
    description:
      "Stop automating headless browsers. Unbrowse reverse-engineers website APIs so AI agents make direct calls. 100x faster, 40x fewer tokens.",
    url: "https://www.unbrowse.ai",
    siteName: "Unbrowse",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        width: 1200,
        height: 630,
        alt: "Unbrowse — The API layer for AI agents",
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
    title: "Unbrowse — Reverse-engineer any website into API skills for AI agents",
    description:
      "Stop automating headless browsers. Unbrowse reverse-engineers website APIs so AI agents make direct calls. 100x faster, 40x fewer tokens.",
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
                "Unbrowse reverse-engineers any website into reusable API skills for AI agents. 100x faster than headless browsers, 40x fewer tokens.",
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
                "Reverse-engineer any website into reusable API skills for AI agents. Auto-discovers undocumented website APIs and converts them to clean, direct API calls.",
              url: "https://www.unbrowse.ai",
              applicationCategory: "DeveloperApplication",
              operatingSystem: "Cross-platform (macOS, Linux, Windows)",
              softwareVersion: "1.1.2",
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
                "Auto-discovers undocumented website APIs",
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
                "Research paper demonstrating that internal website APIs can replace headless browser automation for AI agents, achieving 100x speedup and 40x token reduction.",
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
                    text: "Unbrowse is an open-source tool that reverse-engineers any website into reusable API skills for AI agents. Instead of slow headless browser automation, Unbrowse discovers the internal APIs websites already use and lets agents call them directly — 100x faster and using 40x fewer tokens.",
                  },
                },
                {
                  "@type": "Question",
                  name: "How does Unbrowse work?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Unbrowse passively captures network traffic while you browse, identifies the internal APIs (fetch/XHR calls) that power each page, reverse-engineers their schemas and authentication, and publishes them as reusable skills. AI agents can then call these APIs directly instead of automating a browser.",
                  },
                },
                {
                  "@type": "Question",
                  name: "Which AI coding agents work with Unbrowse?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Unbrowse works with all major AI coding agents including Claude Code, Cursor, OpenClaw, and Windsurf. It installs as a single npm package and integrates via a CLI that any agent can call.",
                  },
                },
                {
                  "@type": "Question",
                  name: "Is Unbrowse free to use?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Yes, Unbrowse is free and open-source. Install it with 'npm install -g unbrowse' and start discovering APIs immediately. The shared skill marketplace lets you benefit from APIs discovered by the community.",
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
