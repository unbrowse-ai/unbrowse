import { describe, expect, it } from "bun:test";
import {
  looksLikeSearchAuthOrHomepageBounceHtml,
  shouldFallbackToBrowserReplay,
} from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";

const lawnetSearchEndpoint: EndpointDescriptor = {
  endpoint_id: "lawnet-search",
  method: "POST",
  url_template: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
  idempotency: "safe",
  verification_status: "verified",
  reliability_score: 0.5,
  description: "Searches documents",
};

describe("LawNet search bounce detection", () => {
  it("detects LawNet homepage/auth bounce html", () => {
    const html = `
      <html>
        <head><title>LawNet</title></head>
        <body>
          <a href="/lawnet/web/lawnet/about-lawnet/what-is-lawnet/general">About LawNet Legal Research</a>
          <div>Forgot Password</div>
          <p>LawNet Legal Research, a service of the Singapore Academy of Law.</p>
        </body>
      </html>
    `;

    expect(
      looksLikeSearchAuthOrHomepageBounceHtml(
        html,
        "https://www.lawnet.sg/lawnet/web/lawnet/home?p_p_state=minimize",
      ),
    ).toBe(true);
  });

  it("keeps html auth/homepage bounces off browser replay", () => {
    const html = `
      <html>
        <head><title>LawNet</title></head>
        <body>
          <a href="/lawnet/web/lawnet/about-lawnet/what-is-lawnet/general">About LawNet Legal Research</a>
          <div>Forgot Password</div>
        </body>
      </html>
    `;

    expect(
      shouldFallbackToBrowserReplay(
        html,
        lawnetSearchEndpoint,
        "search Singapore case law for leave to adduce new evidence after assessment of damages started",
        "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      ),
    ).toBe(false);
  });

  it("still falls back for generic spa shells", () => {
    const html = `
      <html>
        <head><title>Search</title></head>
        <body><div id="root"></div><script src="/assets/app.js"></script></body>
      </html>
    `;

    expect(
      shouldFallbackToBrowserReplay(
        html,
        lawnetSearchEndpoint,
        "search Singapore case law",
        "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      ),
    ).toBe(true);
  });
});
