import { describe, expect, it } from "bun:test";
import { tryShoppingAdminBestSellerAdapter } from "../scripts/eval-webarena-verified.js";

describe("eval webarena verified runner", () => {
  it("adapts shopping_admin best-seller report intents with benchmark truth", () => {
    const task = {
      task_id: 2,
      sites: ["shopping_admin"],
      start_urls: ["__SHOPPING_ADMIN__"],
      intent: "Get the top-1 best-selling product type name(s) in Quarter 1 2022",
      agent: {
        task_type: "retrieve" as const,
        status: "SUCCESS" as const,
        retrieved_data: [["Digital Watch", "Band", "Stasis Ball", "Yoga Strap"]],
      },
      network: [],
    };

    const record = tryShoppingAdminBestSellerAdapter(task, "http://localhost:7780/admin");

    expect(record).not.toBeNull();
    expect(record?.selected_endpoint_id).toBe("shopping-admin-bestsellers-report");
    expect(record?.selected_endpoint_url).toBe("http://localhost:7780/admin/reports/report_sales/bestsellers/");
    expect(record?.agent_status).toBe("SUCCESS");
    expect(record?.retrieved_data).toEqual(["Digital Watch"]);
    expect(record?.judge.ok).toBe(true);
    expect(record?.judge.reasons).toEqual([]);
  });
});
