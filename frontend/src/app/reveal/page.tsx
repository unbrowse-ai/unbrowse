import type { Metadata } from "next";
import { RevealDemo } from "@/components/reveal-demo";

const CANONICAL = "https://www.unbrowse.ai/reveal";
const TITLE = "Wallet-gated reveal — a value rendered only by the wallet bound to it";
const DESCRIPTION =
  "Crypto was all you needed: a value is sealed to a wallet's key and rendered only in the browser, by that wallet. The server holds an opaque envelope it cannot read — render-without-seeing.";

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
    images: [{ url: "https://www.unbrowse.ai/og-image.png", alt: "Unbrowse — wallet-gated reveal" }],
  },
};

export default function RevealPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-16 space-y-8">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold text-text-primary">Wallet-gated reveal</h1>
        <p className="text-text-primary/70">
          A contract value is sealed to a wallet&rsquo;s key. It is rendered <em>only</em> in the browser, by
          that wallet — the server stores an opaque envelope it can never read. No access-control check; the
          decryption math itself is the gate.
        </p>
      </header>
      <RevealDemo />
    </main>
  );
}
