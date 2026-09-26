// G59: the site installs the remote MCP into agents with OAuth — install links and commands carry the server URL
// and never a key.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cursorInstallLink, mcpCommands, vscodeInstallLink } from "./mcp-install.ts";

const URL_ = "https://v3.unbrowse.ai/mcp";

describe("G59 remote MCP install links", () => {
  it("Cursor's link carries the server config, base64", () => {
    const u = new URL(cursorInstallLink(URL_));
    assert.equal(u.protocol, "cursor:");
    assert.equal(u.host, "anysphere.cursor-deeplink");
    assert.equal(u.pathname, "/mcp/install");
    assert.equal(u.searchParams.get("name"), "unbrowse");
    assert.deepEqual(JSON.parse(atob(u.searchParams.get("config")!)), { url: URL_ });
  });

  it("VS Code's links carry a named http server, URL-encoded (stable and Insiders)", () => {
    for (const [link, scheme] of [[vscodeInstallLink(URL_), "vscode:"], [vscodeInstallLink(URL_, true), "vscode-insiders:"]] as const) {
      assert.ok(link.startsWith(`${scheme}mcp/install?`));
      assert.deepEqual(JSON.parse(decodeURIComponent(link.slice(`${scheme}mcp/install?`.length))), { name: "unbrowse", type: "http", url: URL_ });
    }
  });

  it("CLI commands and the JSON config sign in with OAuth: no key, no header", () => {
    const c = mcpCommands(URL_);
    assert.equal(c.claudeCode, `claude mcp add --transport http unbrowse ${URL_}`);
    assert.equal(c.codex, `codex mcp add unbrowse --url ${URL_} && codex mcp login unbrowse`);
    assert.deepEqual(JSON.parse(c.json), { mcpServers: { unbrowse: { url: URL_ } } });
    for (const s of [cursorInstallLink(URL_), vscodeInstallLink(URL_), c.claudeCode, c.codex, c.json]) assert.ok(!/ub_live|bearer|authorization/i.test(decodeURIComponent(s)), s);
  });
});
