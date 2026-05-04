import type { NextConfig } from "next";
import { resolve } from "node:path";

const workspaceRoot = resolve(process.cwd(), "..");

const nextConfig: NextConfig = {
	poweredByHeader: false,
	images: {
		unoptimized: true,
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
