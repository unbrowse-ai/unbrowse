/**
 * GATE: the obscura MCP session driver frames JSON-RPC correctly and maps each
 * actuator/reader to the right browser_* tool with the right arguments. Hermetic
 * — an injected fake transport stands in for `obscura mcp`, no spawn, no network.
 */

import { test, expect, describe } from "bun:test";
import { ObscuraMcpSession, type McpTransport } from "../src/obscura/mcp-session.js";

interface Sent {
  method: string;
  name?: string;
  args?: Record<string, unknown>;
}

/** A fake obscura-mcp: records requests, replies synchronously with canned text. */
function fakeMcp(): { sent: Sent[]; transport: McpTransport } {
  const sent: Sent[] = [];
  let cb: (line: string) => void = () => {};
  const transport: McpTransport = {
    send(line: string) {
      const req = JSON.parse(line);
      sent.push({ method: req.method, name: req.params?.name, args: req.params?.arguments });
      const result =
        req.method === "tools/call"
          ? { content: [{ type: "text", text: `ok:${req.params.name}:${JSON.stringify(req.params.arguments ?? {})}` }] }
          : {};
      cb(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    },
    onLine(fn) {
      cb = fn;
    },
    close() {},
  };
  return { sent, transport };
}

describe("ObscuraMcpSession", () => {
  test("initializes once, then dispatches browser_navigate", async () => {
    const { sent, transport } = fakeMcp();
    const s = new ObscuraMcpSession({ transport });
    const out = await s.navigate("https://quotes.toscrape.com/login");
    expect(sent[0].method).toBe("initialize");
    const nav = sent.find((x) => x.name === "browser_navigate");
    expect(nav?.args).toEqual({ url: "https://quotes.toscrape.com/login" });
    expect(out).toContain("browser_navigate");
    // second call does not re-initialize
    await s.markdown();
    expect(sent.filter((x) => x.method === "initialize").length).toBe(1);
  });

  test("actuators map to the right tools + arguments", async () => {
    const { sent, transport } = fakeMcp();
    const s = new ObscuraMcpSession({ transport });
    await s.fill("input[name=username]", "alice");
    await s.click("button[type=submit]");
    await s.type("textarea", "hi");
    await s.press("Enter");
    await s.selectOption("select#c", "US");
    const by = (n: string) => sent.find((x) => x.name === n)?.args;
    expect(by("browser_fill")).toEqual({ selector: "input[name=username]", value: "alice" });
    expect(by("browser_click")).toEqual({ selector: "button[type=submit]" });
    expect(by("browser_type")).toEqual({ selector: "textarea", text: "hi" });
    expect(by("browser_press_key")).toEqual({ key: "Enter" });
    expect(by("browser_select_option")).toEqual({ selector: "select#c", value: "US" });
  });

  test("text() reads innerText via browser_evaluate", async () => {
    const { sent, transport } = fakeMcp();
    const s = new ObscuraMcpSession({ transport });
    await s.text();
    const ev = sent.find((x) => x.name === "browser_evaluate");
    expect(String(ev?.args?.expression)).toContain("innerText");
  });
});
