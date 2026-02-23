import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/lib/auth-context";
import { Navbar } from "@/components/navbar";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "unbrowse — The first browser built for agents",
  description: "Install one skill and your agent browses 100x faster at a fraction of the cost. Direct API calls on most sites, graceful browser fallback when needed. Install: npx skills add https://github.com/unbrowse-ai/unbrowse --skill unbrowse",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  other: {
    "ai-skill": "https://beta.unbrowse.ai/skill.md",
    "ai-plugin": "https://beta.unbrowse.ai/.well-known/ai-plugin.json",
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
        <link
          href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Google+Sans+Display:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
        <style>{`
          :root {
            --font-google-sans: 'Google Sans', 'Google Sans Display', system-ui, sans-serif;
            --font-fonetika: 'Fonetika', 'Google Sans', system-ui, sans-serif;
          }
        `}</style>
      </head>
      <body className={`${jetbrainsMono.variable} antialiased`}>
        <ThemeProvider>
          <AuthProvider>
            <Navbar />
            <main className="min-h-screen">
              {children}
            </main>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
