import { describe, expect, test } from "bun:test";
import { latestOnly, readCookies, readStorage } from "./cli-output";

/** What `/api/exec` returns: the CLI's stdout, which is the daemon's response (`Response` in cli/src/connection.rs). */
const printed = (response: unknown, success = true) => ({
  success,
  exit_code: success ? 0 : 1,
  stdout: JSON.stringify(response),
  stderr: "",
});

describe("reading what the CLI printed", () => {
  test("a session's cookies are read from inside the response", () => {
    const res = printed({
      success: true,
      data: { cookies: [{ name: "sid", value: "abc", domain: "example.test" }] },
      error: null,
    });
    expect(readCookies(res)).toEqual({
      ok: true,
      value: [{ name: "sid", value: "abc", domain: "example.test" }],
    });
  });

  test("a storage dump lists the page's keys, not the response's", () => {
    const res = printed({ success: true, data: { data: { theme: "dark", length: "3" } }, error: null });
    expect(readStorage(res)).toEqual({
      ok: true,
      value: [
        { key: "theme", value: "dark" },
        { key: "length", value: "3" },
      ],
    });
  });

  test("an empty store is an answer, not a failure", () => {
    expect(readCookies(printed({ success: true, data: { cookies: [] }, error: null }))).toEqual({ ok: true, value: [] });
    expect(readStorage(printed({ success: true, data: { data: {} }, error: null }))).toEqual({ ok: true, value: [] });
  });

  test("a failed command says why instead of reading as an empty store", () => {
    const res = printed({ success: false, data: null, error: "Browser not launched" }, false);
    expect(readCookies(res)).toEqual({ ok: false, error: "Browser not launched" });
    expect(readStorage(res)).toEqual({ ok: false, error: "Browser not launched" });
  });

  test("a refusal from the dashboard server has no stdout and still says why", () => {
    const res = { success: false, error: "Missing \"args\" array" } as never;
    expect(readCookies(res)).toEqual({ ok: false, error: "Missing \"args\" array" });
  });

  test("output that is not the response is a failure", () => {
    const res = { success: true, exit_code: 0, stdout: "not json", stderr: "" };
    expect(readCookies(res).ok).toBe(false);
    expect(readStorage(res).ok).toBe(false);
  });
});

describe("two reads in flight", () => {
  test("only the newest request may show its answer", () => {
    const ticket = latestOnly();
    const first = ticket();
    expect(first()).toBe(true);
    const second = ticket();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
