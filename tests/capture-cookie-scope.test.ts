import { describe, expect, it } from "bun:test";
import { filterFirstPartySessionCookies } from "../src/capture/index.js";

describe("filterFirstPartySessionCookies", () => {
  it("drops third-party adtech cookies from captured sessions", () => {
    const filtered = filterFirstPartySessionCookies([
      { name: "epi", value: "1", domain: ".epicurious.com" },
      { name: "www", value: "1", domain: "www.epicurious.com" },
      { name: "ads", value: "1", domain: ".doubleclick.net" },
      { name: "sync", value: "1", domain: ".criteo.com" },
    ], "https://www.epicurious.com/search?q=lasagna");

    expect(filtered).toEqual([
      { name: "epi", value: "1", domain: ".epicurious.com" },
      { name: "www", value: "1", domain: "www.epicurious.com" },
    ]);
  });

  it("keeps registrable-domain cookies for ccTLD hosts", () => {
    const filtered = filterFirstPartySessionCookies([
      { name: "shop", value: "1", domain: ".example.co.uk" },
      { name: "api", value: "1", domain: "api.example.co.uk" },
      { name: "tracker", value: "1", domain: ".example.com" },
    ], "https://api.example.co.uk/search?q=tea");

    expect(filtered).toEqual([
      { name: "shop", value: "1", domain: ".example.co.uk" },
      { name: "api", value: "1", domain: "api.example.co.uk" },
    ]);
  });
});
