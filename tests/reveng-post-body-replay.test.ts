import { describe, expect, it } from "bun:test";
import { revengLocal } from "../src/capture/reveng-local.js";

describe("local reverse engineering preserves executable POST evidence", () => {
  it("keeps the captured JSON body on a collection endpoint", () => {
    const body = { search: "AI software engineer", sortBy: "new_posting_date" };
    const endpoints = revengLocal([{
      url: "https://api.mycareersfuture.gov.sg/v2/search?limit=20&page=1",
      method: "POST",
      request_headers: { "content-type": "application/json" },
      request_body: JSON.stringify(body),
      response_status: 200,
      response_headers: { "content-type": "application/json" },
      response_body: JSON.stringify({ results: [
        { uuid: "one", title: "AI Engineer" },
        { uuid: "two", title: "Software Engineer" },
        { uuid: "three", title: "Backend Engineer" },
        { uuid: "four", title: "Platform Engineer" },
        { uuid: "five", title: "Machine Learning Engineer" },
      ] }),
      timestamp: "2026-08-03T00:00:00.000Z",
    }], { pageUrl: "https://www.mycareersfuture.gov.sg/jobs" });

    const search = endpoints.find((endpoint) => endpoint.url_template.includes("/v2/search"));
    expect(search).toBeDefined();
    expect(search?.body).toEqual(body);
  });
});
