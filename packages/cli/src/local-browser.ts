// A local browser executor for `unbrowse browse --local`: runs the agent's browse ops in a real browser on this
// machine (the user's own IP and session), records the network, and hands the trace back for private learning.
// Preview: uses patchright when installed (`npx patchright install chromium`), else plain playwright.
import type { LocalBrowseOp, LocalBrowseResult } from "@unbrowse/sdk";

type Page = {
  goto(url: string, opts?: unknown): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  content(): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string, opts?: unknown): Promise<void>;
  waitForLoadState(state?: string, opts?: unknown): Promise<void>;
  on(event: string, fn: (r: unknown) => void): void;
};
type Browser = { newContext(o?: unknown): Promise<{ newPage(): Promise<Page> }>; close(): Promise<void> };

type Exchange = { id: string; seq: number; actionId: string; startedAt: number; method: string; url: string; resourceType: string; requestHeaders: Record<string, string>; status: number; responseHeaders: Record<string, string>; responseBody?: { mimeType: string; text: string } };
type Action = { id: string; label: string; kind: string; inputs?: Record<string, string>; startedAt: number };

/** Load patchright, else playwright; a clear error if neither is installed. */
async function launch(headless: boolean): Promise<Browser> {
  for (const mod of ["patchright", "playwright"]) {
    try {
      const { chromium } = (await import(/* @vite-ignore */ mod)) as { chromium: { launch(o: { headless: boolean }): Promise<Browser> } };
      return await chromium.launch({ headless });
    } catch {
      /* try the next */
    }
  }
  throw new Error("no local browser: install one with `npx patchright install chromium` (or `npm i -g playwright && npx playwright install chromium`)");
}

/** A browse executor bound to one local browser context; pass its `run` to `sdk.runLocalBrowser`. */
export async function localBrowser(opts: { headless?: boolean; origin?: string; onEvent?: (line: string) => void } = {}): Promise<{
  run: (op: LocalBrowseOp) => Promise<LocalBrowseResult>;
  close: () => Promise<void>;
}> {
  const browser = await launch(opts.headless ?? false);
  const context = await browser.newContext();
  const page = await context.newPage();
  const exchanges: Exchange[] = [];
  const actions: Action[] = [];
  let origin = opts.origin ?? "";
  let seq = 0;
  let actionId = "a0";

  // Record same-origin network responses as the trace's exchanges.
  page.on("response", (r: unknown) => {
    void (async () => {
      const res = r as { url(): string; status(): number; request(): { method(): string; resourceType(): string; headers(): Record<string, string> }; headers(): Record<string, string>; text(): Promise<string> };
      try {
        const url = res.url();
        if (origin && !url.startsWith(new URL(origin).origin) && !sameSite(url, origin)) return;
        const ct = res.headers()["content-type"] ?? "";
        const isData = /json|graphql|text\/plain/.test(ct);
        exchanges.push({
          id: `e${exchanges.length}`,
          seq: seq++,
          actionId,
          startedAt: Date.now(),
          method: res.request().method(),
          url,
          resourceType: res.request().resourceType(),
          requestHeaders: pick(res.request().headers()),
          status: res.status(),
          responseHeaders: pick(res.headers()),
          ...(isData ? { responseBody: { mimeType: ct, text: (await res.text().catch(() => "")).slice(0, 500_000) } } : {}),
        });
      } catch {
        /* a response we could not read */
      }
    })();
  });

  const snapshot = async (): Promise<LocalBrowseResult> => {
    const info = await page.evaluate(() => {
      const q = (sel: string) => [...document.querySelectorAll(sel)];
      const controls = q('input:not([type="hidden"]), button, a[href], select, textarea').slice(0, 40).map((el, i) => ({
        ref: `@${i + 1}`,
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type ?? "",
        name: (el as HTMLInputElement).name ?? "",
        text: (el.textContent ?? "").trim().slice(0, 60),
      }));
      return { title: document.title, text: (document.body?.innerText ?? "").slice(0, 4000), controls };
    });
    return { snapshot: { url: page.url(), ...info } as unknown } as LocalBrowseResult;
  };

  const run = async (op: LocalBrowseOp): Promise<LocalBrowseResult> => {
    opts.onEvent?.(`→ ${op.op}${op.op === "open" ? ` ${op.url}` : op.op === "act" ? ` ${op.action} ${op.ref ?? ""}` : ""}`);
    if (op.op === "open") {
      origin = origin || new URL(op.url).origin;
      actionId = `a${actions.length}`;
      actions.push({ id: actionId, label: `open ${op.url}`, kind: "navigate", startedAt: Date.now() });
      await page.goto(op.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
      return snapshot();
    }
    if (op.op === "snapshot") return snapshot();
    if (op.op === "act") {
      actionId = `a${actions.length}`;
      const ref = Number((op.ref ?? "").replace("@", "")) || 1;
      const sel = `:is(input:not([type=hidden]), button, a[href], select, textarea):nth-of-type(${ref})`;
      actions.push({ id: actionId, label: `${op.action} ${op.ref ?? ""}`, kind: op.action === "fill" ? "type" : "click", ...(op.value ? { inputs: { [op.name ?? "value"]: op.value } } : {}), startedAt: Date.now() });
      if (op.action === "fill" && op.value !== undefined) await page.fill(sel, op.value).catch(() => undefined);
      else await page.click(sel, { timeout: 5_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
      return snapshot();
    }
    // finish: hand back the recorded trace for the server to learn (privately).
    const trace = { id: "t0", build: "cli", origin, actions, exchanges, coverage: "complete" };
    return { traces: [trace] };
  };

  return { run, close: () => browser.close() };
}

function pick(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["accept", "content-type", "accept-language"]) if (h[k]) out[k] = h[k]!;
  return out;
}

function sameSite(url: string, origin: string): boolean {
  try {
    const a = new URL(url).hostname.split(".").slice(-2).join(".");
    const b = new URL(origin).hostname.split(".").slice(-2).join(".");
    return a === b;
  } catch {
    return false;
  }
}
