/* /aiko — the agent chat, full page. Same surface as the homepage hero: the
 * ONE chat on the site, backed by the real tool loop (/api/hero-chat —
 * search captured routes, execute the endpoint, answer from live data).
 * The old bare-LLM chat proxy was removed: a chat that
 * can't execute routes misrepresents the product. */

import type { Metadata } from "next";
import { HeroChat } from "@/components/hero-chat";

export const metadata: Metadata = {
  title: "Aiko — the Unbrowse agent, live",
  description:
    "Ask anything. The agent searches captured website API routes, executes the best one with a real HTTP call, and answers from the live data — showing every step it took.",
};

export default function AikoPage() {
  return (
    <main className="relative mx-auto flex min-h-[100dvh] max-w-3xl flex-col justify-center px-5 py-24 text-center sm:px-8">
      <h1 className="mb-3 text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
        Ask the <span className="text-orange-500">live agent</span>
      </h1>
      <p className="mx-auto mb-8 max-w-xl text-[15px] leading-relaxed text-text-secondary">
        It answers through real website APIs — searching captured routes, executing the best one,
        and showing you every step it took.
      </p>
      <HeroChat />
    </main>
  );
}
