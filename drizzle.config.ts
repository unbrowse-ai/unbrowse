import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./backend/src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://unbrowse:unbrowse_dev_password@127.0.0.1:5432/unbrowse",
  },
  extensionsFilters: ["vector"],
});
