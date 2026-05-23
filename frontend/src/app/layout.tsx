import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";

import { AuthProvider } from "@/lib/auth-context";
import { PrivyOptionalProvider } from "@/lib/privy-provider";
import { Navbar } from "@/components/navbar";
import { SiteFooter } from "@/components/site-footer";
import { DocsEmbed } from "@/components/docs-embed";
import { ContentPageTracker } from "@/components/content-page-tracker";
import { AuthInvalidGlobalBanner } from "@/components/auth-invalid-global-banner";
import {
  INSTALL_CMD_MCP,
  VERIFY_CMD,
  FIRST_TASK_CMD,
} from "@/lib/install-command";
import "./globals.css";

export const metadata: Metadata = {
  title: "Unbrowse, one MCP for any website. Direct access for AI agents.",
  description:
    "One MCP server replaces Notion MCP, Browser MCP, Playwright MCP, and per-site scrapers. First visit captures the site's shadow APIs; your agent calls them directly forever after, signed in with your cookies. 3.6x mean speedup vs Playwright across 94 domains.",
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
    title: "Unbrowse, one MCP for any website. Direct access for AI agents.",
    description:
      "One MCP server, any site. First visit captures the site's shadow APIs; your agent calls them directly forever after, signed in with your cookies. No per-site MCP to install.",
    url: "https://www.unbrowse.ai",
    siteName: "Unbrowse",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        width: 1200,
        height: 630,
        alt: "Unbrowse, one MCP for any website. Direct access for AI agents.",
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
    creator: "@lekt8_",
    title: "Unbrowse, one MCP for any website. Direct access for AI agents.",
    description:
      "One MCP server, any site. First visit captures the shadow APIs; your agent calls them directly thereafter, signed in with your cookies. No per-site MCP needed.",
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
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
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
        <link
          key="google-fonts"
          href={`https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Google+Sans+Display:wght@400;500;700&display=swap`}
          rel="stylesheet"
        />
        <style>{`
          :root {
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
                "One MCP server for any website. Unbrowse captures a site's shadow APIs on first visit so AI agents call them directly thereafter, signed in with your cookies. Replaces per-site MCPs and Playwright scripts.",
              sameAs: [
                "https://github.com/unbrowse-ai",
                "https://github.com/unbrowse-ai/unbrowse",
                "https://github.com/justrach/kuri",
                "https://x.com/getFoundry",
                "https://x.com/lekt8_",
                "https://www.npmjs.com/package/unbrowse",
                "https://arxiv.org/abs/2604.00694",
                "https://discord.gg/VWugEeFNsG",
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
                "One MCP for any website. Unbrowse captures a site's shadow APIs on first visit so AI agents call them directly forever after, signed in with the user's cookies. Replaces per-site MCPs (Notion, Slack, Gmail, Browser MCP, Playwright MCP) with one install.",
              url: "https://www.unbrowse.ai",
              applicationCategory: "DeveloperApplication",
              operatingSystem: "macOS, Linux, Windows",
              softwareVersion: "6.17.0",
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
                "Auto-discovers undocumented website APIs",
                "3.6x mean (5.4x median) speedup over Playwright across 94 live domains (arXiv:2604.00694)",
                "Up to 100x faster on cached marketplace routes (50-200ms vs 5-30s)",
                "~200 tokens per action vs ~8000 for full HTML scrape",
                "Shared marketplace of captured endpoints across 600+ domains",
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebPage",
              url: "https://www.unbrowse.ai",
              name: "Unbrowse",
              description:
                "Direct access to anything on the web, without setting up another MCP. Unbrowse captures website shadow APIs once and lets agents call them directly thereafter.",
              speakable: {
                "@type": "SpeakableSpecification",
                cssSelector: [
                  "#agent-instructions",
                  "h1",
                  "#objections h2",
                ],
              },
              isPartOf: {
                "@type": "WebSite",
                url: "https://www.unbrowse.ai",
                name: "Unbrowse",
              },
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "HowTo",
              name: "Install Unbrowse and wire it into an MCP-aware agent",
              description:
                "Clone the Unbrowse repo, run setup for your agent host, verify the install, and execute the first resolve. End-to-end in under two minutes on macOS or Linux.",
              totalTime: "PT2M",
              supply: [
                {
                  "@type": "HowToSupply",
                  name: "Node.js 18+ and git on the local machine",
                },
                {
                  "@type": "HowToSupply",
                  name: "An MCP-aware agent host (Claude Desktop, Cursor, Codex, OpenClaw, or another MCP client)",
                },
              ],
              tool: [
                {
                  "@type": "HowToTool",
                  name: "Unbrowse CLI",
                  url: "https://www.npmjs.com/package/unbrowse",
                },
              ],
              step: [
                {
                  "@type": "HowToStep",
                  position: 1,
                  name: "Install the Unbrowse MCP server",
                  text: INSTALL_CMD_MCP,
                  url: "https://www.unbrowse.ai/#install",
                },
                {
                  "@type": "HowToStep",
                  position: 2,
                  name: "Verify the install",
                  text: VERIFY_CMD,
                  url: "https://www.unbrowse.ai/#install",
                },
                {
                  "@type": "HowToStep",
                  position: 3,
                  name: "Run the first resolve",
                  text: FIRST_TASK_CMD,
                  url: "https://www.unbrowse.ai/#install",
                },
              ],
              inLanguage: "en-US",
              isAccessibleForFree: true,
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
              <AuthInvalidGlobalBanner />
              <a href="#main-content" className="skip-link">
                Skip to main content
              </a>
              <Navbar />
              <main id="main-content" className="min-h-[100dvh]">
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
