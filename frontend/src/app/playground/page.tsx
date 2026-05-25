import type { Metadata } from "next";
import Link from "next/link";
import { UnbrowseChatLive } from "@/components/unbrowse-chat-live";
import { AskAnythingChat } from "@/components/ask-anything-chat";

const CANONICAL_PATH = "/playground";
const TITLE = "Playground — try Unbrowse and the chat API live";
const DESCRIPTION =
  "Anonymous, no-signup trial of both Unbrowse (resolve an intent against the public skill marketplace) and the Foundry chat API (10 free queries per day, Qwen3.5-397B-A17B). Both fully live, both free to test.";

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description: DESCRIPTION,
  alternates: { canonical: `https://www.unbrowse.ai${CANONICAL_PATH}` },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "website",
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        alt: "Unbrowse playground — live trial of resolve + chat",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
};

export default function PlaygroundPage() {
  return (
    <div className="bg-[#060402] text-[rgba(255,250,242,0.92)] min-h-[100dvh]">
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-12">
        <div className="grid gap-4 max-w-3xl">
          <span
            className="text-[11px] font-mono uppercase tracking-[0.2em]"
            style={{ color: "#FFB060" }}
          >
            playground · live, anonymous, no signup
          </span>
          <h1 className="text-3xl sm:text-4xl font-medium tracking-tight" style={{ color: "#fff" }}>
            Try both sides of the stack.
          </h1>
          <p className="text-base leading-relaxed" style={{ color: "rgba(255,250,242,0.65)" }}>
            On the left: <span style={{ color: "#FFB060" }}>Unbrowse resolve</span> — type an intent and a
            site; we hit the public marketplace and rank skills.
            On the right: <span style={{ color: "#FFB060" }}>ask anything</span> — talk to the live
            chat API. 10 free queries per IP per day, no account.
          </p>
          <p className="text-sm" style={{ color: "rgba(255,176,96,0.55)" }}>
            Neither widget asks for keys. Both call real backends. If something looks off, the latency
            and trace id are in the footer — file an{" "}
            <a
              href="https://github.com/unbrowse-ai/unbrowse/issues/new"
              target="_blank"
              rel="noopener"
              style={{ color: "#FF7A20", textDecoration: "underline" }}
            >
              issue
            </a>
            .
          </p>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="grid lg:grid-cols-2 gap-5">
          <div className="grid gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2
                className="text-[11px] font-mono uppercase tracking-[0.2em]"
                style={{ color: "#FF7A20" }}
              >
                ▸ resolve an intent
              </h2>
              <Link
                href="/internal-apis-are-all-you-need"
                className="text-[10px] font-mono uppercase tracking-[0.18em]"
                style={{ color: "rgba(255,122,32,0.55)" }}
              >
                paper →
              </Link>
            </div>
            <UnbrowseChatLive />
            <p className="text-[11px] font-mono leading-relaxed" style={{ color: "rgba(255,122,32,0.55)" }}>
              Marketplace is sparse for newer sites. Empty result = the route hasn&apos;t been mined yet —
              install the CLI locally to teach it: <span style={{ color: "#FFB060" }}>npx unbrowse setup</span>
            </p>
          </div>

          <div className="grid gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2
                className="text-[11px] font-mono uppercase tracking-[0.2em]"
                style={{ color: "#FF7A20" }}
              >
                ▸ ask anything
              </h2>
              <a
                href="https://chat.unbrowse.ai"
                target="_blank"
                rel="noopener"
                className="text-[10px] font-mono uppercase tracking-[0.18em]"
                style={{ color: "rgba(255,122,32,0.55)" }}
              >
                docs / buy credits →
              </a>
            </div>
            <AskAnythingChat />
            <p className="text-[11px] font-mono leading-relaxed" style={{ color: "rgba(255,122,32,0.55)" }}>
              Direct prose answers — no scaffolding, no JSON dumps, no chain-of-thought leak. OpenAI-compatible at{" "}
              <span style={{ color: "#FFB060" }}>chat.unbrowse.ai/v1/chat/completions</span>.
            </p>
          </div>
        </div>

        <div
          className="mt-10 grid sm:grid-cols-3 gap-3 text-[11px] font-mono"
          style={{ color: "rgba(255,250,242,0.55)" }}
        >
          <FactCard label="resolve latency" value="~150–400ms" hint="bm25 + embedding rerank over the marketplace" />
          <FactCard label="chat backend" value="Qwen3.5-397B-A17B" hint="thinking model · reasoning channel hidden" />
          <FactCard label="cost to test" value="$0" hint="anonymous free tier on both widgets" />
        </div>
      </section>
    </div>
  );
}

function FactCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div
      className="px-4 py-3 rounded-md"
      style={{
        background: "rgba(255,122,32,0.04)",
        border: "1px solid rgba(255,122,32,0.25)",
      }}
    >
      <div className="text-[10px] uppercase tracking-[0.2em]" style={{ color: "rgba(255,122,32,0.55)" }}>
        {label}
      </div>
      <div className="text-base mt-1" style={{ color: "#FFB060" }}>
        {value}
      </div>
      <div className="text-[10.5px] mt-1 leading-relaxed" style={{ color: "rgba(255,250,242,0.4)" }}>
        {hint}
      </div>
    </div>
  );
}
