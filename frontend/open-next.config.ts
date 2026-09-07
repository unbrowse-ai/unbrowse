import { defineCloudflareConfig } from "@opennextjs/cloudflare";

let config;
if (process.env.CLOUDFLARE_ENV === "experiments") {
	// Experiments: no R2 bucket — use static assets cache
	const { default: staticCache } = require("@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache");
	config = defineCloudflareConfig({ incrementalCache: staticCache });
} else {
	// Production: use R2 incremental cache
	const { default: r2Cache } = require("@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache");
	config = defineCloudflareConfig({ incrementalCache: r2Cache });
}

export default config;
