import type { Metadata } from "next";
import { ComparisonPage } from "../comparison-page";
import { competitors } from "../compare-data";

const c = competitors.puppeteer;

export const metadata: Metadata = {
  title: `${c.tagline} — Puppeteer Alternative for AI Agents | Unbrowse`,
  description: c.description,
  alternates: {
    canonical: `https://www.unbrowse.ai/compare/${c.slug}`,
  },
  keywords: c.keywords,
  openGraph: {
    title: `${c.tagline} — Puppeteer Alternative for AI Agents`,
    description: c.description,
    url: `https://www.unbrowse.ai/compare/${c.slug}`,
    siteName: "Unbrowse",
    type: "article",
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        width: 1200,
        height: 630,
        alt: c.tagline,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@getFoundry",
    title: `${c.tagline} — Puppeteer Alternative for AI Agents`,
    description: c.description,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
};

export default function PuppeteerCompare() {
  return <ComparisonPage slug="puppeteer" eyebrow="vs Puppeteer" />;
}
