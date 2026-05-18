import "server-only";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadDocMarkdown } from "@/lib/docs-renderer";

export const metadata: Metadata = {
	title: "How Unbrowse pays, x402 first, API keys optional, indexers earn",
	description:
		"Every Unbrowse call settles on-chain via Faremeter Flex by default. API keys are an optional billing layer for users who want subscription tiers. Indexers earn 50% of revenue from skills they discovered.",
};

// Source of truth: unbrowse/docs/HOW_UNBROWSE_PAYS.md. Read at build time.
const DOC_SLUG = "HOW_UNBROWSE_PAYS";

export default function HowUnbrowsePays() {
	const doc = loadDocMarkdown(DOC_SLUG);
	if (!doc.found) notFound();

	return (
		<main className="mx-auto max-w-[70ch] px-6 py-16 space-y-10">
			<header className="space-y-3">
				<Link
					href="/"
					className="text-xs text-text-muted hover:text-text-secondary"
				>
					← Home
				</Link>
				<h1 className="text-3xl font-semibold tracking-tight text-text-primary">
					How Unbrowse Pays
				</h1>
			</header>
			<article
				className="docs-markdown"
				dangerouslySetInnerHTML={{ __html: doc.html }}
			/>
		</main>
	);
}
