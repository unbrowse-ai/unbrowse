import { describe, expect, it } from "bun:test";
import {
  jsonApiPathCompatible,
  normalizeApiPath,
  structuralJsonApiMirrorUrls,
  urlLooksLikeJsonApi,
} from "../src/values/url-shape.js";
import { settleJsonApiStructuralMirrors } from "../src/values/json-api-mirror.js";

describe("structural JSON-API mirror candidates (free residual, no host allowlist)", () => {
  it("urlLooksLikeJsonApi still matches swapi / spacex leaves", () => {
    expect(urlLooksLikeJsonApi("https://swapi.dev/api/people/1/")).toBe(true);
    expect(urlLooksLikeJsonApi("https://api.spacexdata.com/v5/launches/latest")).toBe(true);
  });

  it("jsonApiPathCompatible matches same path on different host", () => {
    expect(
      jsonApiPathCompatible(
        "https://swapi.dev/api/people/1/",
        "https://swapi.info/api/people/1/",
      ),
    ).toBe(true);
    expect(
      jsonApiPathCompatible(
        "https://swapi.dev/api/people/1/",
        "https://swapi.info/",
      ),
    ).toBe(false);
  });

  it("normalizeApiPath strips trailing slash", () => {
    expect(normalizeApiPath("https://swapi.dev/api/people/1/")).toBe("/api/people/1");
  });

  it("structuralJsonApiMirrorUrls transplants path onto off-origin hits", () => {
    const mirrors = structuralJsonApiMirrorUrls(
      "https://swapi.dev/api/people/1/",
      [
        { url: "https://swapi.info/" },
        { url: "https://swapi.dev/" }, // same host — skip transplant of exact origin
        { url: "https://swapi.online/api/people/1" },
      ],
      5,
    );
    expect(mirrors.some((u) => u.includes("swapi.info") && u.includes("/api/people/1"))).toBe(true);
    expect(mirrors.some((u) => u.includes("swapi.online"))).toBe(true);
    // never returns the dead origin path as the only candidate
    expect(mirrors.every((u) => !u.startsWith("https://swapi.dev/api/people/1"))).toBe(true);
  });

  it("settleJsonApiStructuralMirrors returns first usable JSON", async () => {
    const settled = await settleJsonApiStructuralMirrors({
      requestedUrl: "https://swapi.dev/api/people/1/",
      hits: [{ url: "https://swapi.info/" }, { url: "https://example.com/" }],
      tryFetch: async (url) => {
        if (url.includes("swapi.info") && url.includes("/api/people/1")) {
          return { data: { name: "Luke Skywalker" }, content_type: "application/json" };
        }
        return null;
      },
    });
    expect(settled).not.toBeNull();
    expect((settled!.data as { name: string }).name).toBe("Luke Skywalker");
    expect(settled!.mirror_url).toContain("swapi.info");
    expect(settled!.origin_url).toContain("swapi.dev");
  });

  it("settleJsonApiStructuralMirrors fails closed when no mirror returns JSON", async () => {
    const settled = await settleJsonApiStructuralMirrors({
      requestedUrl: "https://swapi.dev/api/people/1/",
      hits: [{ url: "https://swapi.info/" }],
      tryFetch: async () => null,
    });
    expect(settled).toBeNull();
  });
});
