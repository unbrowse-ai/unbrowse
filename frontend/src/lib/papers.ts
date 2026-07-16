// Single source of truth for the Unbrowse papers. The papers/page.tsx index and any
// page that surfaces "the papers behind this" read from here so every reflection stays
// consistent. Only the flagship paper is published on unbrowse.ai; the companion PDFs
// have been withdrawn from the site and archived off-repo.

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
];

export function papersByTheme(theme: PaperTheme): Paper[] {
  return PAPERS.filter((paper) => paper.themes.includes(theme));
}
