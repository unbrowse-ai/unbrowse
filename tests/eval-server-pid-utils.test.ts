import { describe, expect, it } from "bun:test";

import { parsePortListenerPids } from "../evals/server-pid-utils.js";

describe("parsePortListenerPids", () => {
  it("drops empty lines, pid zero, duplicates, and blocked pids", () => {
    expect(parsePortListenerPids("\n0\n123\n123\n456\n", [456])).toEqual([123]);
  });
});
