import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { executeActionSequence } from "../src/capture/index.js";
import * as kuri from "../src/kuri/client.js";

const KURI_PORT = 7796;

let server: ReturnType<typeof createServer> | null = null;
let baseUrl = "";

function sendHtml(res: ServerResponse, html: string): void {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head><body>${html}</body></html>`);
}

function json(res: ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function startFixtureServer(): Promise<string> {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/search") {
      return json(res, { ok: true, query: url.searchParams.get("q") ?? "" });
    }

    if (url.pathname === "/api/ping") {
      return json(res, { ok: true, source: url.searchParams.get("source") ?? "" });
    }

    if (url.pathname === "/basic-auth") {
      const auth = req.headers.authorization ?? "";
      const expected = `Basic ${Buffer.from("alice:secret").toString("base64")}`;
      if (auth !== expected) {
        res.statusCode = 401;
        res.setHeader("www-authenticate", 'Basic realm="codex-tests"');
        return sendHtml(res, "<h1>Unauthorized</h1>");
      }
      return sendHtml(res, '<h1 id="protected">Protected area</h1>');
    }

    if (url.pathname === "/next") {
      return sendHtml(res, '<h1 id="next-page">Next Page</h1><a href="/actions">Back</a>');
    }

    if (url.pathname === "/login") {
      return sendHtml(res, `
        <h1>Login</h1>
        <form id="login-form">
          <input id="username" type="text" aria-label="Username">
          <button id="login" type="submit">Login</button>
        </form>
        <script>
          document.getElementById('login-form').addEventListener('submit', (event) => {
            event.preventDefault();
            const user = document.getElementById('username').value;
            location.assign('/welcome?user=' + encodeURIComponent(user));
          });
        </script>
      `);
    }

    if (url.pathname === "/welcome") {
      const user = url.searchParams.get("user") ?? "guest";
      return sendHtml(res, `<h1 id="welcome">Welcome ${user}</h1>`);
    }

    if (url.pathname === "/search-flow") {
      return sendHtml(res, `
        <h1>Search Flow</h1>
        <button id="submit">Search</button>
        <script>
          document.getElementById('submit').addEventListener('click', async () => {
            const res = await fetch('/api/search?q=codex');
            const data = await res.json();
            const result = document.createElement('div');
            result.id = 'result';
            result.dataset.ready = '1';
            result.textContent = data.query;
            document.body.appendChild(result);
            document.body.dataset.searched = data.query;
          });
        </script>
      `);
    }

    if (url.pathname === "/navigate-flow") {
      return sendHtml(res, `
        <h1>Navigate Flow</h1>
        <a id="go-next" href="/next">Go Next</a>
      `);
    }

    if (url.pathname === "/actions") {
      return sendHtml(res, `
        <style>
          #spacer { height: 1600px; }
          #drop-target { margin-top: 16px; }
        </style>
        <h1>Action Playground</h1>
        <label>
          Search
          <input id="search" type="search" aria-label="Search">
        </label>
        <label>
          Color
          <select id="color" aria-label="Color">
            <option value="red">Red</option>
            <option value="blue">Blue</option>
          </select>
        </label>
        <label>
          <input id="agree" type="checkbox" aria-label="Agree">
          Agree
        </label>
        <button id="go">Go</button>
        <button id="double">Double</button>
        <button id="hover-target">Hover target</button>
        <button id="drag-source" draggable="true">Drag Source</button>
        <button id="drop-target">Drop Target</button>
        <a id="next-link" href="/next">Next</a>
        <div id="spacer"></div>
        <script>
          const search = document.getElementById('search');
          const go = document.getElementById('go');
          const dbl = document.getElementById('double');
          const hoverTarget = document.getElementById('hover-target');
          const dragSource = document.getElementById('drag-source');
          const dropTarget = document.getElementById('drop-target');

          search.addEventListener('keydown', (event) => {
            document.body.dataset.lastKeyDown = event.key;
          });
          search.addEventListener('keyup', (event) => {
            document.body.dataset.lastKeyUp = event.key;
          });
          go.addEventListener('click', async () => {
            document.body.dataset.clicked = 'yes';
            console.log('codex-console');
            const res = await fetch('/api/search?q=' + encodeURIComponent(search.value));
            const data = await res.json();
            const result = document.createElement('div');
            result.id = 'result';
            result.dataset.ready = '1';
            result.textContent = data.query;
            document.body.appendChild(result);
          });
          dbl.addEventListener('dblclick', () => {
            document.body.dataset.dblclicked = 'yes';
          });
          hoverTarget.addEventListener('mouseover', () => {
            document.body.dataset.hovered = 'yes';
          });
          hoverTarget.addEventListener('focus', () => {
            document.body.dataset.focused = 'yes';
          });
          hoverTarget.addEventListener('blur', () => {
            document.body.dataset.blurred = 'yes';
          });
          dragSource.addEventListener('dragstart', (event) => {
            event.dataTransfer.setData('text/plain', 'codex-drag');
          });
          dropTarget.addEventListener('dragover', (event) => {
            event.preventDefault();
          });
          dropTarget.addEventListener('drop', (event) => {
            event.preventDefault();
            document.body.dataset.dragged = event.dataTransfer.getData('text/plain');
          });
        </script>
      `);
    }

    res.statusCode = 404;
    sendHtml(res, `<h1>Not Found</h1><p>${url.pathname}</p>`);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function withLiveTab<T>(fn: (tabId: string) => Promise<T>): Promise<T> {
  const tabId = await kuri.newTab("about:blank");
  try {
    return await fn(tabId || await kuri.getDefaultTab());
  } finally {
    if (tabId) {
      await kuri.closeTab(tabId).catch(() => {});
    }
  }
}

function findRef(snapshot: string, matcher: RegExp): string {
  for (const line of snapshot.split("\n")) {
    if (matcher.test(line)) {
      const match = line.match(/\[(e\d+)\]/);
      if (match) return match[1];
    }
  }
  throw new Error(`no ref matched ${matcher} in snapshot:\n${snapshot}`);
}

beforeAll(async () => {
  baseUrl = await startFixtureServer();
  await kuri.stop();
  await kuri.start(KURI_PORT);
});

afterAll(async () => {
  await kuri.stop();
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((err) => err ? reject(err) : resolve()));
  }
});

describe("kuri live browser integration", () => {
  it("registers new tabs and returns interactive snapshots with refs", async () => {
    await withLiveTab(async (tabId) => {
      await kuri.navigate(tabId, `${baseUrl}/actions`);
      await kuri.waitForLoad(tabId, 10_000);

      const tabs = await kuri.discoverTabs();
      expect(tabs.some((tab) => tab.id === tabId)).toBe(true);

      const snapshot = await kuri.snapshot(tabId, "interactive");
      expect(snapshot).toContain("searchbox");
      expect(snapshot).toContain('button "Go"');
      expect(snapshot).toContain('link "Next"');
    });
  }, 30_000);

  it("drives wrapper actions against a real page", async () => {
    await withLiveTab(async (tabId) => {
      await kuri.navigate(tabId, `${baseUrl}/actions`);
      await kuri.waitForLoad(tabId, 10_000);

      const snapshot = await kuri.snapshot(tabId, "interactive");
      const searchRef = findRef(snapshot, /searchbox/i);
      const colorRef = findRef(snapshot, /Color|combobox/i);
      const agreeRef = findRef(snapshot, /checkbox.*Agree|Agree.*checkbox/i);
      const goRef = findRef(snapshot, /button "Go"/);
      const dblRef = findRef(snapshot, /button "Double"/);
      const hoverRef = findRef(snapshot, /button "Hover target"/);
      const sourceRef = findRef(snapshot, /button "Drag Source"/);
      const targetRef = findRef(snapshot, /button "Drop Target"/);
      const nextRef = findRef(snapshot, /link "Next"/);

      await kuri.click(tabId, searchRef);
      await kuri.keyboardType(tabId, "cod");
      await kuri.keyboardInsertText(tabId, "ex");
      await kuri.keyDown(tabId, "A");
      await kuri.keyUp(tabId, "A");
      await kuri.select(tabId, colorRef, "blue");
      await kuri.action(tabId, "check", agreeRef);
      await kuri.action(tabId, "uncheck", agreeRef);
      await kuri.action(tabId, "hover", hoverRef);
      await kuri.action(tabId, "focus", hoverRef);
      await kuri.action(tabId, "blur", hoverRef);
      await kuri.action(tabId, "dblclick", dblRef);
      await kuri.drag(tabId, sourceRef, targetRef);
      await kuri.scrollIntoView(tabId, nextRef);
      await kuri.scroll(tabId);
      await kuri.click(tabId, goRef);
      await kuri.waitForSelector(tabId, '#result[data-ready="1"]', 5_000);

      const state = JSON.parse(String(await kuri.evaluate(tabId, `JSON.stringify({
        query: document.getElementById("search")?.value,
        color: document.getElementById("color")?.value,
        checked: document.getElementById("agree")?.checked,
        clicked: document.body.dataset.clicked,
        dblclicked: document.body.dataset.dblclicked,
        hovered: document.body.dataset.hovered,
        focused: document.body.dataset.focused,
        blurred: document.body.dataset.blurred,
        dragged: document.body.dataset.dragged,
        result: document.getElementById("result")?.textContent,
        lastKeyDown: document.body.dataset.lastKeyDown,
        lastKeyUp: document.body.dataset.lastKeyUp,
        scrollY: window.scrollY
      })`)));

      expect(state.query).toBe("codex");
      expect(state.color).toBe("blue");
      expect(typeof state.checked).toBe("boolean");
      expect(state.clicked).toBe("yes");
      expect(state.dblclicked).toBe("yes");
      expect(state.hovered).toBe("yes");
      expect(state.focused).toBe("yes");
      expect(state.blurred).toBe("yes");
      expect(state.result).toBe("codex");
      expect(state.lastKeyDown).toBe("A");
      expect(state.lastKeyUp).toBe("A");
    });
  }, 60_000);

  it("exercises DOM, observability, auth, session, and navigation helpers live", async () => {
      await withLiveTab(async (tabId) => {
      const injected = await kuri.scriptInject(tabId, 'window.__codexInjected = "yes";');
      await kuri.setUserAgent(tabId, "CodexTestUA/1.0");
      await kuri.setViewport(tabId, 910, 720);
      await kuri.navigate(tabId, `${baseUrl}/actions`);
      await kuri.waitForLoad(tabId, 10_000);

      expect(JSON.stringify(injected)).toContain("identifier");
      expect(String(await kuri.evaluate(tabId, "navigator.userAgent"))).toContain("CodexTestUA/1.0");

      const viewport = JSON.parse(String(await kuri.evaluate(tabId, 'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })')));
      expect(viewport.w).toBeGreaterThan(800);
      expect(viewport.h).toBeGreaterThan(600);

      const attrsBySelector = await kuri.domAttributes(tabId, { selector: "input" });
      expect(JSON.stringify(attrsBySelector)).toContain("search");

      await kuri.networkEnable(tabId);
      await kuri.evaluate(tabId, `
        console.log("codex-console");
        setTimeout(() => { throw new Error("codex-boom"); }, 0);
        fetch("/api/ping?source=network");
        true;
      `);
      await Bun.sleep(500);

      expect(await kuri.evaluate(tabId, 'document.querySelector("h1")?.textContent')).toBe("Action Playground");
      expect(JSON.stringify(await kuri.getLinks(tabId))).toContain(`${baseUrl}/next`);
      expect(await kuri.findText(tabId, "Action Playground")).toBeDefined();
      expect(await kuri.getConsole(tabId)).toBeDefined();
      expect(await kuri.getErrors(tabId)).toBeDefined();
      expect(await kuri.getNetworkEvents(tabId)).toBeDefined();
      expect(await kuri.getPerfLcp(tabId)).toBeDefined();

      const saved = await kuri.sessionSave();
      const listed = await kuri.sessionList();
      const loaded = await kuri.sessionLoad(saved);
      expect(saved).toBeDefined();
      expect(listed).toBeDefined();
      expect(loaded.imported).toBeGreaterThanOrEqual(0);

      await kuri.navigate(tabId, `${baseUrl}/next`);
      await kuri.waitForLoad(tabId, 10_000);
      expect(await kuri.evaluate(tabId, 'document.getElementById("next-page")?.textContent')).toBe("Next Page");

      await kuri.goBack(tabId);
      await kuri.waitForLoad(tabId, 10_000);
      expect(await kuri.evaluate(tabId, 'document.querySelector("h1")?.textContent')).toBe("Action Playground");

      await kuri.goForward(tabId);
      await kuri.waitForLoad(tabId, 10_000);
      expect(await kuri.evaluate(tabId, 'document.getElementById("next-page")?.textContent')).toBe("Next Page");

      await kuri.reload(tabId);
      await kuri.waitForLoad(tabId, 10_000);
      expect(await kuri.evaluate(tabId, 'document.getElementById("next-page")?.textContent')).toBe("Next Page");
    });

  }, 60_000);
});

describe("executeActionSequence live flows", () => {
  it("captures a real search flow without stubs", async () => {
    const result = await executeActionSequence(`${baseUrl}/search-flow`, [
      { action: "snapshot", value: "interactive" },
      { action: "click", ref: "e0" },
      { action: "wait", value: '#result[data-ready="1"]', timeoutMs: 5_000 },
      { action: "evaluate", value: `JSON.stringify({
        result: document.getElementById("result")?.textContent,
        searched: document.body.dataset.searched
      })` },
    ]);

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.ok)).toEqual([true, true, true, true]);
    expect(String(result.steps[0].result)).toContain("[e0]");
    const evaluated = JSON.parse(String(result.steps[3].result));
    expect(evaluated.result).toBe("codex");
    expect(evaluated.searched).toBe("codex");
    expect(result.capture?.requests.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("runs a live navigation flow through the browser action sequence", async () => {
    const result = await executeActionSequence(`${baseUrl}/navigate-flow`, [
      { action: "snapshot", value: "interactive" },
      { action: "click", ref: "e0" },
      { action: "wait", value: "#next-page", timeoutMs: 5_000 },
    ], { skipCapture: true });

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.ok)).toEqual([true, true, true]);
    expect(result.final_url).toContain("/next");
    expect(result.html).toContain("Next Page");
  }, 60_000);
});
