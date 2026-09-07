import type { NextConfig } from "next";
import { resolve } from "node:path";

const workspaceRoot = resolve(process.cwd(), "..");

const nextConfig: NextConfig = {
	poweredByHeader: false,
	images: {
		// `unoptimized: true` is REQUIRED on the Cloudflare Pages deploy.
		// opennextjs-cloudflare's native image-optimization handler 500s
		// (CF error 1101 — Worker exception) on the live deploy for every
		// `<Image>` request, breaking the navbar logo + hero hands + saint eagle.
		// The raw assets are already optimized webp/png (`logo-optimized.webp`,
		// `*-optimized.webp`), so skipping the optimizer loses nothing real.
		// Re-enable AVIF/WebP resizing only when the adapter handler is verified
		// green on prod (not just claimed supported in a changelog).
		unoptimized: true,
	},
	output: "standalone",
	turbopack: {
		root: workspaceRoot,
	},
	async redirects() {
		// /vs/<slug> is the shorthand naming Lewis prefers. Canonical pages live
		// at /compare/<slug> (existing SEO, OG tags, etc). Redirect /vs/* → /compare/*
		// so both work without duplicating content.
		return [
			{ source: "/vs/:slug", destination: "/compare/:slug", permanent: true },
		];
	},
};

export default nextConfig;

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
