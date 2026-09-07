import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";

import { AuthProvider } from "@/lib/auth-context";
import { PrivyOptionalProvider } from "@/lib/privy-provider";
import { Navbar } from "@/components/navbar";
import { SiteFooter } from "@/components/site-footer";
import { DocsEmbed } from "@/components/docs-embed";
import { ContentPageTracker } from "@/components/content-page-tracker";
import "./globals.css";

export const metadata: Metadata = {
  title: "Unbrowse — The route layer for web agents",
  description:
    "Action layer for AI agents: learn first-party website routes once, reuse them on later calls, and keep a real browser only when the site still requires it.",
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
    title: "Unbrowse — The route layer for web agents",
    description:
      "Action layer for AI agents: first-party routes first, browser when needed. Capture once, replay everywhere.",
    url: "https://www.unbrowse.ai",
    siteName: "Unbrowse",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        width: 1200,
        height: 630,
        alt: "Unbrowse — The route layer for web agents",
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
    title: "Unbrowse — The route layer for web agents",
    description:
      "Action layer for AI agents: first-party routes first, browser when needed. Capture once, replay everywhere.",
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
  other: {
    "ai-plugin": "https://www.unbrowse.ai/.well-known/ai-plugin.json",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* No-flash theme: set data-theme before first paint from the saved
            choice, else the visitor's OS preference. Runs blocking in <head>
            so the correct theme is applied before the body renders. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('unbrowse-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`,
          }}
        />
        <link
          key="llms-txt"
          rel="alternate"
          type="text/plain"
          href="/llms.txt"
          title="LLM Site Information"
        />
        <link
          key="gfonts-preconnect"
          rel="preconnect"
          href="https://fonts.googleapis.com"
        />
        <link
          key="gstatic-preconnect"
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          key="umami-preconnect"
          rel="preconnect"
          href="https://cloud.umami.is"
        />
        {/* PERF: load the LCP-critical display family with high priority
            so the hero H1's font swap fires inside the first paint
            window instead of at ~5.6s post-load. Still display:swap so
            we never block paint, but fetchpriority high pushes the
            request out of the queue immediately. */}
        <link
          key="google-fonts"
          href={`https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Google+Sans+Display:wght@400;500;700&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&display=swap`}
          rel="stylesheet"
          // @ts-expect-error - fetchpriority is a valid HTML hint;
          // React types haven't caught up.
          fetchpriority="high"
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
              legalName: "Unbrowse AI Pte. Ltd.",
              url: "https://www.unbrowse.ai",
              logo: "https://www.unbrowse.ai/logo.png",
              description:
                "Unbrowse turns known first-party website routes into reusable skills for AI agents, with browser fallback on misses.",
              sameAs: [
                "https://github.com/unbrowse-ai",
                "https://github.com/unbrowse-ai/unbrowse",
                "https://x.com/getFoundry",
                "https://www.npmjs.com/package/unbrowse",
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
                "Learns first-party website routes into reusable API skills for AI agents and keeps browser automation as the fallback path.",
              url: "https://www.unbrowse.ai",
              applicationCategory: "DeveloperApplication",
              operatingSystem: "macOS, Linux, Windows",
              softwareVersion: "11.3.2",
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
                name: "Unbrowse",
                url: "https://www.unbrowse.ai",
              },
              featureList: [
                "Learns first-party website routes from real browsing",
                "3.6x mean and 5.4x median speedup in the 94-domain paper benchmark",
                "Structured route responses reduce token-heavy page parsing",
                "Shared marketplace of captured and maintained endpoint routes",
                "Plugs into OpenClaw, Claude Desktop, Cursor, Codex, and any MCP-aware framework",
                "Self-hosted Postgres backend with pgvector (provider-agnostic)",
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
      <body className="antialiased overflow-x-hidden">
        <ThemeProvider>
          <PrivyOptionalProvider>
            <AuthProvider>
              <ContentPageTracker />
              <Navbar />
              <main className="min-h-screen">
                {children}
              </main>
              <SiteFooter />
              <DocsEmbed />
            </AuthProvider>
          </PrivyOptionalProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
