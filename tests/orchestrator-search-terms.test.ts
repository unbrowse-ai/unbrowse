import { describe, expect, it } from "bun:test";
import {
  extractLiteralSearchTermsFromIntent,
  extractSearchTermsFromIntent,
  inferSearchParamOverrides,
  selectSearchTermsForExecution,
} from "../src/orchestrator/index.js";

describe("search term extraction", () => {
  it("keeps simple search prompts intact", () => {
    expect(extractSearchTermsFromIntent("search for high court assessment of damages started")).toBe(
      "high court assessment of damages started",
    );
  });

  it("condenses long legal research prompts into usable keyword queries", () => {
    const terms = extractSearchTermsFromIntent(
      "im doing an application for leave to adduce new evidence at a late stage after the notice for appointment for assessment of damages. my boss says there is a high court case where the AD had in fact already started and the court allowed new evidence even at that stage. search extremely thoroughly and find that case.",
    );
    expect(terms).toContain("leave");
    expect(terms).toContain("adduce");
    expect(terms).toContain("evidence");
    expect(terms).toContain("assessment");
    expect(terms).toContain("damages");
    expect(terms).toContain("high");
    expect(terms).toContain("court");
    expect(terms?.split(/\s+/).length).toBeLessThanOrEqual(14);
    expect(terms?.length).toBeLessThan(160);
  });

  it("preserves search action and late prompt keywords for the exact LawNet-style wall of text", () => {
    const terms = extractSearchTermsFromIntent(
      "im doing an application for leave to adduce new evidence at a late stage after the notice for appointment for assessment of damages checklist certifying all reports are in was signed and the matter was about to go for assessment of damages (AD) but just that we adjourned it togo for mediation which failed and now we are taking up the application to introduce new evidence. my boss says there is a high court case where the AD had in fact already started eg 1 or more tranches done and the court allowed new evidence even at that stage. search extremely thoroughly and find that case but do not throw me random cases for thesake of it. if there is no such high court case, tell me.",
    );
    expect(terms?.startsWith("search ")).toBe(true);
    expect(terms).toContain("high");
    expect(terms).toContain("court");
    expect(terms).toContain("tranches");
    expect(terms).toContain("started");
    expect(terms).toContain("assessment");
    expect(terms).toContain("damages");
    expect(terms?.split(/\s+/).length).toBeLessThanOrEqual(14);
  });

  it("preserves quoted phrases for literal search-param extraction", () => {
    expect(extractLiteralSearchTermsFromIntent('search "supplementary AEICs" "assessment of damages"')).toBe(
      '"supplementary AEICs" "assessment of damages"',
    );
  });

  it("preserves salient long-form clauses for literal search-param extraction", () => {
    const terms = extractLiteralSearchTermsFromIntent(
      "im doing an application for leave to adduce new evidence at a late stage after the notice for appointment for assessment of damages checklist certifying all reports are in was signed and the matter was about to go for assessment of damages (AD) but just that we adjourned it togo for mediation which failed and now we are taking up the application to introduce new evidence. my boss says there is a high court case where the AD had in fact already started eg 1 or more tranches done and the court allowed new evidence even at that stage. search extremely thoroughly and find that case but do not throw me random cases for thesake of it. if there is no such high court case, tell me.",
    );
    expect(terms).toContain("1 or more tranches done");
    expect(terms).toContain("allowed new evidence even at that stage");
    expect(terms).not.toContain("random cases");
    expect(terms).not.toContain("if there is no such high court case");
  });

  it("uses compact quoted phrase queries for long narrative prompts during execution", () => {
    const terms = selectSearchTermsForExecution(
      "im doing an application for leave to adduce new evidence at a late stage after the notice for appointment for assessment of damages checklist certifying all reports are in was signed and the matter was about to go for assessment of damages (AD) but just that we adjourned it togo for mediation which failed and now we are taking up the application to introduce new evidence. my boss says there is a high court case where the AD had in fact already started eg 1 or more tranches done and the court allowed new evidence even at that stage. search extremely thoroughly and find that case but do not throw me random cases for thesake of it. if there is no such high court case, tell me.",
    );
    expect(terms).toContain("leave to adduce");
    expect(terms).toContain("assessment of damages");
    expect(terms).toContain("allowed new evidence");
    expect(terms).toMatch(/started|tranches/);
    expect(terms?.length).toBeLessThanOrEqual(140);
  });

  it("overrides captured body search params with literal search terms", () => {
    const endpoint = {
      endpoint_id: "lawnet-search",
      method: "POST",
      url_template: "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
      body_params: {
        basic_search_key: "stale captured query",
      },
      description: "LawNet basic search results",
    } as const;
    const overrides = inferSearchParamOverrides(
      endpoint as never,
      'search "supplementary AEICs" "assessment of damages"',
    );
    expect(overrides).toEqual({
      basic_search_key: '"supplementary AEICs" "assessment of damages"',
    });
  });

  it("overrides captured body search params with compact phrase queries when the literal narrative is too long", () => {
    const endpoint = {
      endpoint_id: "lawnet-search",
      method: "POST",
      url_template: "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
      body_params: {
        basic_search_key: "stale captured query",
      },
      description: "LawNet basic search results",
    } as const;
    const overrides = inferSearchParamOverrides(
      endpoint as never,
      "im doing an application for leave to adduce new evidence at a late stage after the notice for appointment for assessment of damages checklist certifying all reports are in was signed and the matter was about to go for assessment of damages (AD) but just that we adjourned it togo for mediation which failed and now we are taking up the application to introduce new evidence. my boss says there is a high court case where the AD had in fact already started eg 1 or more tranches done and the court allowed new evidence even at that stage. search extremely thoroughly and find that case but do not throw me random cases for thesake of it. if there is no such high court case, tell me.",
    );
    expect(overrides.basic_search_key).toContain("leave to adduce");
    expect(overrides.basic_search_key).toContain("assessment of damages");
    expect(overrides.basic_search_key).toContain("allowed new evidence");
    expect(overrides.basic_search_key).toMatch(/started|tranches/);
    expect(overrides.basic_search_key.length).toBeLessThanOrEqual(140);
  });

  it("does not override generic slug path params just because the endpoint description says search", () => {
    const endpoint = {
      endpoint_id: "lawnet-search",
      method: "POST",
      url_template: "https://www.lawnet.sg/{slug}/{slug_2}/{slug_3}/result-page",
      path_params: {
        slug: "lawnet",
        slug_2: "group",
        slug_3: "lawnet",
      },
      body_params: {
        basic_search_key: "stale captured query",
      },
      description: "Searches LawNet case rows",
    } as const;
    const overrides = inferSearchParamOverrides(
      endpoint as never,
      "search for late-stage assessment of damages fresh evidence",
    );
    expect(overrides).toEqual({
      basic_search_key: "late-stage assessment of damages fresh evidence",
    });
  });
});
