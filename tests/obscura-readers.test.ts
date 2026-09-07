/**
 * GATE: the Chrome-free eval readers build the right obscura CLI invocation and
 * parse its output. Pure — no spawn, no network.
 */

import { test, expect, describe } from "bun:test";
import { buildDumpArgs, parseCookieDump } from "../src/obscura/readers.js";

describe("buildDumpArgs", () => {
  test("base dump is quiet + kind", () => {
    expect(buildDumpArgs("https://x.test/", "text")).toEqual([
      "fetch", "https://x.test/", "--dump", "text", "--quiet",
    ]);
  });
  test("threads wait-until, wait, stealth", () => {
    expect(
      buildDumpArgs("https://x.test/", "markdown", { waitUntil: "networkidle2", waitSeconds: 3, stealth: true }),
    ).toEqual([
      "fetch", "https://x.test/", "--dump", "markdown", "--quiet",
      "--wait-until", "networkidle2", "--wait", "3", "--stealth",
    ]);
  });
});

describe("parseCookieDump", () => {
  test("parses obscura's cookie JSON array", () => {
    const jar = parseCookieDump('[{"name":"sid","value":"abc","domain":"x.test","path":"/","secure":true,"httpOnly":true}]');
    expect(jar.length).toBe(1);
    expect(jar[0].name).toBe("sid");
    expect(jar[0].httpOnly).toBe(true);
  });
  test("empty / malformed => []", () => {
    expect(parseCookieDump("")).toEqual([]);
    expect(parseCookieDump("not json")).toEqual([]);
    expect(parseCookieDump("{}")).toEqual([]);
  });
});
