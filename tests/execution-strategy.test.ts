import { describe, expect, it } from "bun:test";
import { shouldIgnoreLearnedBrowserStrategy } from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";

const baseEndpoint: EndpointDescriptor = {
  endpoint_id: "ep-1",
  method: "GET",
  url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerOrganizationDashCompanies",
  idempotency: "safe",
  verification_status: "verified",
};

describe("shouldIgnoreLearnedBrowserStrategy", () => {
  it("ignores stale browser strategy for safe API endpoints", () => {
    expect(
      shouldIgnoreLearnedBrowserStrategy(baseEndpoint, "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerOrganizationDashCompanies"),
    ).toBe(true);
  });

  it("keeps browser strategy for document-like endpoints", () => {
    expect(
      shouldIgnoreLearnedBrowserStrategy(
        { ...baseEndpoint, url_template: "https://www.linkedin.com/company/openai/about/" },
        "https://www.linkedin.com/company/openai/about/",
      ),
    ).toBe(false);
  });
});
