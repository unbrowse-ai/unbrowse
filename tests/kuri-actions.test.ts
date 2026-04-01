import { describe, expect, it } from "bun:test";
import * as kuri from "../src/kuri/client.js";

/**
 * Tests for Kuri action/keyboard/wait/session/DOM wrappers.
 *
 * These tests require a running Kuri server. Since Kuri may not be available
 * in CI or local dev without explicit setup, tests that call kuri endpoints
 * are marked .todo(). The export surface tests verify the module shape.
 */

describe("kuri action wrapper exports", () => {
  it("click is exported", () => {
    expect(typeof kuri.click).toBe("function");
  });

  it("fill is exported", () => {
    expect(typeof kuri.fill).toBe("function");
  });

  it("select is exported", () => {
    expect(typeof kuri.select).toBe("function");
  });

  it("scroll is exported", () => {
    expect(typeof kuri.scroll).toBe("function");
  });

  it("press is exported", () => {
    expect(typeof kuri.press).toBe("function");
  });

  it("action is exported", () => {
    expect(typeof kuri.action).toBe("function");
  });
});

describe("kuri wait wrapper exports", () => {
  it("waitForSelector is exported", () => {
    expect(typeof kuri.waitForSelector).toBe("function");
  });

  it("waitForLoad is exported", () => {
    expect(typeof kuri.waitForLoad).toBe("function");
  });
});

describe("kuri keyboard wrapper exports", () => {
  it("keyboardType is exported", () => {
    expect(typeof kuri.keyboardType).toBe("function");
  });

  it("keyboardInsertText is exported", () => {
    expect(typeof kuri.keyboardInsertText).toBe("function");
  });

  it("keyDown is exported", () => {
    expect(typeof kuri.keyDown).toBe("function");
  });

  it("keyUp is exported", () => {
    expect(typeof kuri.keyUp).toBe("function");
  });
});

describe("kuri DOM wrapper exports", () => {
  it("domQuery is exported", () => {
    expect(typeof kuri.domQuery).toBe("function");
  });

  it("domHtml is exported", () => {
    expect(typeof kuri.domHtml).toBe("function");
  });

  it("domAttributes is exported", () => {
    expect(typeof kuri.domAttributes).toBe("function");
  });
});

describe("kuri scroll/drag wrapper exports", () => {
  it("scrollIntoView is exported", () => {
    expect(typeof kuri.scrollIntoView).toBe("function");
  });

  it("drag is exported", () => {
    expect(typeof kuri.drag).toBe("function");
  });
});

describe("kuri auth/viewport wrapper exports", () => {
  it("setCredentials is exported", () => {
    expect(typeof kuri.setCredentials).toBe("function");
  });

  it("setViewport is exported", () => {
    expect(typeof kuri.setViewport).toBe("function");
  });

  it("setUserAgent is exported", () => {
    expect(typeof kuri.setUserAgent).toBe("function");
  });
});

describe("kuri session wrapper exports", () => {
  it("sessionSave is exported", () => {
    expect(typeof kuri.sessionSave).toBe("function");
  });

  it("sessionLoad is exported", () => {
    expect(typeof kuri.sessionLoad).toBe("function");
  });

  it("sessionList is exported", () => {
    expect(typeof kuri.sessionList).toBe("function");
  });
});

describe("kuri navigation wrapper exports", () => {
  it("goBack is exported", () => {
    expect(typeof kuri.goBack).toBe("function");
  });

  it("goForward is exported", () => {
    expect(typeof kuri.goForward).toBe("function");
  });

  it("reload is exported", () => {
    expect(typeof kuri.reload).toBe("function");
  });
});

describe("kuri observability wrapper exports", () => {
  it("getNetworkEvents is exported", () => {
    expect(typeof kuri.getNetworkEvents).toBe("function");
  });

  it("getPerfLcp is exported", () => {
    expect(typeof kuri.getPerfLcp).toBe("function");
  });

  it("findText is exported", () => {
    expect(typeof kuri.findText).toBe("function");
  });

  it("getLinks is exported", () => {
    expect(typeof kuri.getLinks).toBe("function");
  });

  it("getConsole is exported", () => {
    expect(typeof kuri.getConsole).toBe("function");
  });

  it("getErrors is exported", () => {
    expect(typeof kuri.getErrors).toBe("function");
  });
});

describe("kuri script injection exports", () => {
  it("scriptInject is exported", () => {
    expect(typeof kuri.scriptInject).toBe("function");
  });
});

describe("kuri actions (requires running kuri instance)", () => {
  it.todo("click sends action=click with ref");
  it.todo("fill sends action=fill with ref and value");
  it.todo("select sends action=select with ref and value");
  it.todo("scroll sends action=scroll with placeholder ref");
  it.todo("press sends action=press with key value");
  it.todo("generic action passes through all params");
  it.todo("waitForSelector sends selector and timeout");
  it.todo("waitForLoad sends no selector");
  it.todo("keyboardType sends text parameter");
  it.todo("keyboardInsertText sends to inserttext endpoint");
  it.todo("keyDown sends key parameter");
  it.todo("keyUp sends key parameter");
  it.todo("domQuery sends selector");
  it.todo("domQuery with all=true sends all param");
  it.todo("domHtml sends node_id");
  it.todo("domAttributes with ref");
  it.todo("domAttributes with selector");
  it.todo("scrollIntoView sends ref");
  it.todo("drag sends source and target");
  it.todo("setCredentials sends username and password");
  it.todo("setViewport sends width and height");
  it.todo("setUserAgent sends ua string");
  it.todo("sessionSave calls /session/save");
  it.todo("sessionLoad posts state to /session/load");
  it.todo("sessionList calls /session/list");
  it.todo("goBack calls /back");
  it.todo("goForward calls /forward");
  it.todo("reload calls /reload");
  it.todo("getNetworkEvents calls /network");
  it.todo("getPerfLcp calls /perf/lcp");
  it.todo("findText calls /find with query");
  it.todo("getLinks calls /links");
  it.todo("getConsole calls /console");
  it.todo("getErrors calls /errors");
  it.todo("scriptInject posts source to /script/inject");
});
