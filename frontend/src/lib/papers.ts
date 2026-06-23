// Single source of truth for the Unbrowse papers. The papers/page.tsx index and any
// page that surfaces "the papers behind this" read from here so every reflection stays
// consistent with what passed the paper-gate. Titles/subtitles/hrefs match the canonical
// papers index (docs/the-unbrowse-papers.md) and the compiled PDFs in frontend/public/.
//
// The six are framed as the Infinity Stones (secular, public-tier): one argument seen from
// six sides. Order below = the release sequence (paper/release-order.tsv).

export type PaperTheme = "zk-privacy" | "economy";

export type Paper = {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  pdf: boolean;
  description: string;
  themes: PaperTheme[];
};

export const PAPERS: Paper[] = [
  {
    id: "internal-apis-are-all-you-need",
    title: "Internal APIs Are All You Need",
    subtitle: "Shadow APIs, Shared Discovery, and the Case Against Browser-First Agent Architectures",
    href: "/internal-apis-are-all-you-need",
    pdf: false,
    description:
      "🔵 Space — the wedge. The internal APIs already powering modern websites are the machine-native interface for autonomous agents; a shared route graph turns repeated browser rediscovery into collective memory. 3.6× mean (5.4× median) speedup across 94 live domains (Tham, Mac Gregor Garcia, Hahn — arXiv:2604.00694).",
    themes: [],
  },
  {
    id: "crypto-was-all-you-needed",
    title: "Sign Everything. No, Everything.",
    subtitle: "A Signed, Layer-Descending Stack: Identity, Authentication, and Zero-Knowledge Privacy across the Agent Stack",
    href: "/crypto-was-all-you-needed.pdf",
    pdf: true,
    description:
      "🔴 Reality — the signed chain defines what's real. One signing discipline holds at every layer an agent touches: screen, browser, CLI, OS, kernel, packet. A single Ed25519 wallet key signs every layer, credentials are bound to it by zero-knowledge proof and revealed only under signature, every result is content-addressed and sealed, and nothing crosses a layer unsigned. The cache–ledger core ships as runnable, tested code.",
    themes: ["zk-privacy"],
  },
  {
    id: "execute-dont-guess",
    title: "Run It or It Didn't Happen",
    subtitle: "Reproduced-Win Benchmarks for Small-Model Tool Routing",
    href: "/execute-dont-guess.pdf",
    pdf: true,
    description:
      "🟢 Time — it only counts if it re-runs. One unglamorous rule: a published number is admissible only if a command re-runs it green, with the losses printed in the same font as the wins. Applied to a 0.8B tool-routing agent: nine reproduced wins and five honest negatives. A benchmark you cannot lose is a benchmark you cannot trust.",
    themes: [],
  },
  {
    id: "identity-was-all-you-needed",
    title: "You Are Your Keys (Sorry)",
    subtitle: "Wallet-as-Identity, Sealed Disclosure, and Capability-Grant Access for Agents",
    href: "/identity-was-all-you-needed.pdf",
    pdf: true,
    description:
      "🟠 Soul — who you are, and who may see. Your wallet key is a first-class identity with no account database underneath it; every value is sealed to the key and revealed only under signature; read access is a signed, scoped, revocable capability grant. Authentication, disclosure, and authorization are three readings of one signed object — candid about what it does not close (revocation latency, key loss, metadata).",
    themes: [],
  },
  {
    id: "unbrowse-maintenance-network",
    title: "Wait, Who's Going to Maintain All This?",
    subtitle: "The Unbrowse Maintenance Network: Proof of Indexing and Bonded Accountability in a Shared Route Graph",
    href: "/unbrowse-maintenance-network.pdf",
    pdf: true,
    description:
      "🟣 Power — the staked coin that keeps the graph alive. Discovery is a one-time cost; freshness is a standing liability. A route's freshness becomes a verifiable artifact — a proof of indexing in the lineage of The Graph and Filecoin — secured by bonded, slashable maintenance. Usage settles in stable coin; the security token only ever bonds trust, never the bill. Honest about the open Sybil limit.",
    themes: ["economy"],
  },
  {
    id: "energy-route-ranking",
    title: "Stop Picking Routes by Vibes",
    subtitle: "Fractal Cell Energy: A Biological Architecture for Route Selection over an Agent's Tool Library",
    href: "/energy-route-ranking.pdf",
    pdf: true,
    description:
      "🟡 Mind — selection is a number, not a vibe. Each route is a cell carrying a scalar energy it trains every time it fires (a reward-weighted running-mean prototype, O(1) per firing); selection is argmin energy, scale-free up the atom→cell→organ fractal. Wins on discrete structure (route ranking 4.6× a keyword baseline) and, honestly, contributes +0.000 to free-form prose — the boundary is the contribution.",
    themes: [],
  },
];

export function papersByTheme(theme: PaperTheme): Paper[] {
  return PAPERS.filter((paper) => paper.themes.includes(theme));
}
