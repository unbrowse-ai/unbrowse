import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [cloudflare({ configPath: "./wrangler.vite.jsonc", viteEnvironment: { name: "ssr" } }), tanstackStart(), viteReact()],
});
