import type { NextConfig } from "next";
import { resolve } from "node:path";

const workspaceRoot = resolve(process.cwd(), "..");

const nextConfig: NextConfig = {
	poweredByHeader: false,
	images: {
		// Previously `unoptimized: true` (commit 2352069c, Mar 30) because a custom
		// loader broke under opennextjs-cloudflare. The adapter has shipped a
		// first-party Image Optimization handler since ~v1.x; v1.19.11 (current)
		// supports it natively. Flipping back lets `<Image>` ship resized AVIF/WebP
		// instead of raw source bytes (PERF-AUDIT, fix 1).
		formats: ["image/avif", "image/webp"],
	},
	output: "standalone",
	turbopack: {
		root: workspaceRoot,
	},
};

export default nextConfig;

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
