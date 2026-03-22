import { expect, test } from "bun:test";
import { resolveExecutionUrlTemplate } from "../src/execution/index.js";

test("keeps inferred api subdomain urls instead of rewriting them to the context page", () => {
  const endpoint = {
    endpoint_id: "module-list",
    method: "GET",
    url_template: "https://api.nusmods.com/v2/2025-2026/moduleList.json",
    idempotency: "safe",
    verification_status: "pending",
    reliability_score: 0.45,
    description: "Inferred from HTML fetch preload for module list",
    trigger_url: "https://nusmods.com/",
  } as const;

  expect(resolveExecutionUrlTemplate(endpoint, "https://nusmods.com/")).toBe(
    "https://api.nusmods.com/v2/2025-2026/moduleList.json",
  );
});
