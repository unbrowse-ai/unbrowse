import "server-only";
import type { Metadata } from "next";
import Link from "next/link";
import { HOW_UNBROWSE_PAYS_HTML } from "@/lib/generated/how-unbrowse-pays.html";

export const metadata: Metadata = {
	title: "How Unbrowse pays — Privy wallet first, API keys optional, indexers earn",
	description:
		"Every Unbrowse call settles on-chain via Faremeter Flex by default. Sign in with Privy to bind a wallet; API keys are an optional subscription layer. Indexers earn 50% of revenue from skills they discovered.",
};

// Source of truth: unbrowse/docs/HOW_UNBROWSE_PAYS.md. The HTML is generated
// from the markdown via frontend/scripts/codegen-docs.mjs and lives in
// src/lib/generated/how-unbrowse-pays.html.ts. Re-run codegen when the doc
// changes. We inline rather than fs.readFileSync because opennextjs-cloudflare
// worker bundling silently dropped the runtime fs read (observed 2026-05-27 on
// v7.0.2 build f73058494: page emitted 404 because doc.found was false at
// build time despite the file existing on disk).

export const dynamic = "force-static";

export default function HowUnbrowsePays() {
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
				dangerouslySetInnerHTML={{ __html: HOW_UNBROWSE_PAYS_HTML }}
			/>
		</main>
	);
}
