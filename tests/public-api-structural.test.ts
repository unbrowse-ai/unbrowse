import { describe, expect, it } from "bun:test";
import { derivePublicApiEndpointsFromUrl } from "../src/execution/index.js";
import { urlLooksLikeJsonApi } from "../src/values/url-shape.js";

describe("derivePublicApiEndpointsFromUrl — structural free API (no host allowlist)", () => {
  it("seeds a GET endpoint for jsonplaceholder-class REST resource leaves", () => {
    const url = "https://jsonplaceholder.typicode.com/posts/1";
    expect(urlLooksLikeJsonApi(url)).toBe(true);
    const eps = derivePublicApiEndpointsFromUrl(url, "get post");
    expect(eps.length).toBe(1);
    expect(eps[0]!.method).toBe("GET");
    expect(eps[0]!.url_template).toContain("{id}");
    expect(eps[0]!.path_params?.id).toBe("1");
    expect(eps[0]!.semantic?.action_kind).toBe("fetch");
  });

  it("seeds a GET endpoint for api.* versioned REST leaves", () => {
    const url = "https://api.spacexdata.com/v5/launches/latest";
    expect(urlLooksLikeJsonApi(url)).toBe(true);
    const eps = derivePublicApiEndpointsFromUrl(url, "latest launch");
    expect(eps.length).toBe(1);
    expect(eps[0]!.method).toBe("GET");
    expect(eps[0]!.url_template).toBe("https://api.spacexdata.com/v5/launches/latest");
  });

  it("seeds a GET endpoint for /api/ paths without per-host entries", () => {
    const url = "https://swapi.dev/api/people/1/";
    const eps = derivePublicApiEndpointsFromUrl(url, "get person");
    expect(eps.length).toBe(1);
    expect(eps[0]!.url_template).toContain("swapi.dev");
    expect(eps[0]!.url_template).toContain("{id}");
  });

  it("does not invent endpoints for marketing HTML roots", () => {
    expect(derivePublicApiEndpointsFromUrl("https://www.airbnb.com/s/San-Francisco", "list stays")).toEqual([]);
    expect(derivePublicApiEndpointsFromUrl("https://medium.com/@x/post", "read post")).toEqual([]);
    expect(derivePublicApiEndpointsFromUrl("https://www.airbnb.com/rooms/12345", "get room")).toEqual([]);
  });

  it("host-specific templates still win over structural fallback (crates.io)", () => {
    const url = "https://crates.io/search?q=serde";
    const eps = derivePublicApiEndpointsFromUrl(url, "search rust crates packages");
    expect(eps.length).toBe(1);
    expect(eps[0]!.url_template).toContain("api/v1/crates");
    expect(eps[0]!.query?.q).toBe("serde");
  });
});
