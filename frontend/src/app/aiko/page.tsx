/* /aiko — Aiko, the grounded assistant. Backed by the Aiko endpoint
 * (OpenAI-compatible) which grounds every external fact through unbrowse's
 * route graph (free, keyless DDG) and answers from what it finds — showing
 * the unbrowse source under each answer. The same endpoint + unbrowse the CLI
 * uses, on the web. */

import type { Metadata } from "next";
import { AikoChat } from "@/components/aiko-chat";

export const metadata: Metadata = {
  title: "Aiko — grounded by unbrowse",
  description:
    "Ask anything. Aiko grounds every answer through unbrowse's route graph — searching the live web for free, then answering from what it found, and showing you the source.",
};

export default function AikoPage() {
  return (
    <main className="relative mx-auto flex min-h-[100dvh] max-w-3xl flex-col justify-center px-5 py-24 text-center sm:px-8">
      <h1 className="mb-3 text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
        Ask <span className="text-orange-500">Aiko</span>
      </h1>
      <p className="mx-auto mb-8 max-w-xl text-[15px] leading-relaxed text-text-secondary">
        A grounded assistant — it answers by searching the live web through unbrowse&apos;s
        route graph for free, then shows you the source it grounded on.
      </p>
      <AikoChat />
    </main>
  );
}
