/* /aiko — the Aiko chat as a first-class feature (the live demo of the registry).
 * The homepage (/) is the Smithery-style registry; this is the conversational
 * surface, linked prominently from the home's "See it work" section. */

import type { Metadata } from "next";
import { AikoHome } from "@/components/aiko-home";

export const metadata: Metadata = {
  title: "Aiko — ask anything, answered live through Unbrowse routes",
  description: "Aiko (aiko-0.8b) runs your question live through captured website API routes and shows the answer plus the routes it used, with latency. 10 free queries/day.",
};

export default function AikoPage() {
  return <AikoHome />;
}
