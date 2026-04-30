import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

// Regression: `-p key=val` was silently dropped as a positional arg, so
// `unbrowse execute --skill X --endpoint Y -p q=foo` reached the executor
// with no params and crashed with `invalid_replay_params`. The CLI now
// parses -p / --param and merges the kv map into body.params.

describe("cli parseArgs: -p key=val", () => {
  test("captures repeated -p flags into params map", () => {
    const r = parseArgs([
      "node", "cli", "execute",
      "--skill", "S1", "--endpoint", "E1",
      "-p", "q=elon", "-p", "limit=5",
      "-p", "page=1", "-p", "source=q",
      "--raw",
    ]);
    expect(r.command).toBe("execute");
    expect(r.flags.skill).toBe("S1");
    expect(r.flags.endpoint).toBe("E1");
    expect(r.flags.raw).toBe(true);
    expect(r.params).toEqual({ q: "elon", limit: "5", page: "1", source: "q" });
    expect(r.args).toEqual([]); // -p key=val must not pollute positional
  });

  test("--param long form works identically", () => {
    const r = parseArgs(["node", "cli", "execute", "--skill", "S", "--endpoint", "E", "--param", "q=foo"]);
    expect(r.params).toEqual({ q: "foo" });
  });

  test("values with = inside (e.g. base64 padding) keep first = as separator", () => {
    const r = parseArgs(["node", "cli", "execute", "--skill", "S", "--endpoint", "E", "-p", "token=abc=="]);
    expect(r.params).toEqual({ token: "abc==" });
  });

  test("flag boundary: --endpoint followed immediately by -p does not eat -p as a value", () => {
    const r = parseArgs(["node", "cli", "execute", "--endpoint", "-p", "q=foo"]);
    // --endpoint is a boolean flag because next token is -p (not a value).
    expect(r.flags.endpoint).toBe(true);
    expect(r.params).toEqual({ q: "foo" });
  });
});
