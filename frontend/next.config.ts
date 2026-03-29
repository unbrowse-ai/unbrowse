import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	poweredByHeader: false,
	images: {
		loader: "custom",
		loaderFile: "./src/image-loader.ts",
	},
	turbopack: {
		root: "..",
	},
};

export default nextConfig;

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
