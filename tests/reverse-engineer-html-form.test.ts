import { describe, expect, it } from "bun:test";
import { extractEndpoints, type ExtractionContext } from "../src/reverse-engineer/index.js";
import type { RawRequest } from "../src/capture/index.js";

describe("reverse-engineer html form results", () => {
  it("keeps same-domain HTML search form results as safe DOM endpoints", () => {
    const responseBody = `<!doctype html>
<html>
  <body>
    <main>
      <article>
        <a href="/cases/1">Case One v Two [2024] SGHC 1</a>
        <p>Application to adduce new evidence after assessment of damages tranche started</p>
      </article>
      <article>
        <a href="/cases/2">Case Three v Four [2023] SGHC 2</a>
        <p>Leave to adduce fresh evidence after judgment</p>
      </article>
    </main>
  </body>
</html>`;

    const requests: RawRequest[] = [
      {
        url: "https://www.lawnet.sg/lawnet/group/lawnet/result-page?action=basicSearch",
        method: "POST",
        request_headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        request_body: "grouping=1&category=1&category=2&basicSearchKey=assessment+of+damages+new+evidence",
        response_status: 200,
        response_headers: {
          "content-type": "text/html",
        },
        response_body: responseBody,
        timestamp: new Date().toISOString(),
      },
    ];
    const context: ExtractionContext = {
      pageUrl: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      finalUrl: "https://www.lawnet.sg/lawnet/group/lawnet/result-page?action=basicSearch",
      intent: "search for high court case assessment of damages new evidence adduced after tranches started",
    };

    const endpoints = extractEndpoints(requests, undefined, context);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.method).toBe("POST");
    expect(endpoints[0]?.idempotency).toBe("safe");
    expect(endpoints[0]?.dom_extraction?.extraction_method).toBe("repeated-elements");
    expect(endpoints[0]?.response_schema?.type).toBe("array");
    expect(endpoints[0]?.headers_template?.["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(String(endpoints[0]?.body?.basicSearchKey ?? "")).toContain("{");
    expect(Object.keys(endpoints[0]?.body_params ?? {})).toContain("basic_search_key");
    expect(endpoints[0]?.body?.category).toEqual(["1", "2"]);
  });
});
