// Single source of truth for the Unbrowse papers. The papers/page.tsx index and any
// page that surfaces "the papers behind this" read from here so every reflection stays
// consistent with what passed the paper-gate. Titles/subtitles/hrefs/descriptions are
// VERBATIM from the canonical papers index — do not reword (they are gate-checked).

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
      "The Unbrowse paper (Tham, Mac Gregor Garcia, Hahn — arXiv:2604.00694) arguing that the internal APIs already powering modern websites are the machine-native interface for autonomous agents, and that a shared route graph turns repeated browser rediscovery into collective memory.",
    themes: [],
  },
  {
    id: "crypto-was-all-you-needed",
    title: "Crypto Was All You Needed",
    subtitle: "A Signed, Layer-Descending Stack: Identity, Authentication, and Zero-Knowledge Privacy across the Agent Stack",
    href: "/crypto-was-all-you-needed.pdf",
    pdf: true,
    description:
      "The security companion: one signing discipline holds at every layer an agent touches — screen, browser, CLI, OS, kernel, packet. A single Ed25519 wallet key signs every layer, credentials are bound to it by zero-knowledge proof and revealed only under signature, every result is content-addressed and sealed, and nothing crosses a layer unsigned. Each layer is pinned to an established cryptographic primitive, with the cache–ledger core shipped as runnable, tested code.",
    themes: ["zk-privacy"],
  },
  {
    id: "unbrowse-maintenance-network",
    title: "Unbrowse Maintenance Network",
    subtitle: "Proof of Indexing and Bonded Accountability in a Shared Route Graph",
    href: "/unbrowse-maintenance-network.pdf",
    pdf: true,
    description:
      "The economics companion: discovery is a one-time cost, but freshness is a standing liability. This paper makes a route's freshness a verifiable artifact — a proof of indexing in the lineage of The Graph and Filecoin — secured by bonded, slashable maintenance, stratified into trust tiers, and paid by delta-based attribution. Honest throughout about what is shipped, what ships as runnable reference code, and where the Sybil limit stays open.",
    themes: ["economy"],
  },
];

export function papersByTheme(theme: PaperTheme): Paper[] {
  return PAPERS.filter((paper) => paper.themes.includes(theme));
}
