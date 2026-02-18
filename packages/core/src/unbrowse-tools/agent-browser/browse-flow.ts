import { runAgentBrowser } from "../../agent-browser/runner.js";
import { snapshotInteractive } from "../../agent-browser/snapshot.js";
import { captureHarFromAgentBrowser } from "../../agent-browser/har.js";

export async function browseWithAgentBrowser(opts: {
  url: string;
  actions: Array<{
    action: string;
    index?: number;
    text?: string;
    direction?: "down" | "up";
    amount?: number;
    selector?: string;
  }>;
  captureTraffic?: boolean;
  learnOnFly?: boolean;
}): Promise<{
  session: string;
  interactive: string[];
  capture?: {
    requestCount: number;
    har: { log: { entries: any[] } };
    cookies: Record<string, string>;
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
  };
}> {
  const session = `unbrowse-${Date.now()}`;

  const openRes = await runAgentBrowser(["--session", session, "open", opts.url]);
  if (openRes.code !== 0) {
    throw new Error(openRes.stderr || openRes.stdout || "agent-browser open failed");
  }

  async function resolveRefByIndex(index: number): Promise<{ ref: string | null; elements: any[] }> {
    const elements = await snapshotInteractive(session);
    const el = elements.find((e) => e.index === index);
    return { elements, ref: el ? `@${el.ref}` : null };
  }

  let last = await snapshotInteractive(session);

  for (const act of opts.actions ?? []) {
    const kind = String(act?.action || "");
    if (!kind) continue;

    if (kind === "go_to_url") {
      const nextUrl = String(act?.selector || "");
      if (!nextUrl) continue;
      const r = await runAgentBrowser(["--session", session, "open", nextUrl]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || `open failed: ${nextUrl}`);
      await runAgentBrowser(["--session", session, "wait", "--load", "networkidle"]).catch(() => null);
      last = await snapshotInteractive(session);
      continue;
    }

    if (kind === "wait") {
      const ms = Number.isFinite(act?.amount) ? Math.trunc(act.amount as number) : 1500;
      await runAgentBrowser(["--session", session, "wait", "--timeout", String(ms)]).catch(() => null);
      last = await snapshotInteractive(session);
      continue;
    }

    if (kind === "scroll") {
      const dir = (act?.direction === "up") ? "up" : "down";
      const amount = Number.isFinite(act?.amount) ? Math.trunc(act.amount as number) : 800;
      await runAgentBrowser(["--session", session, "scroll", dir, String(amount)]).catch(() => null);
      last = await snapshotInteractive(session);
      continue;
    }

    if (kind === "click_element") {
      const idx = Number.isFinite(act?.index) ? Math.trunc(act.index as number) : 0;
      if (idx <= 0) continue;
      const { ref, elements } = await resolveRefByIndex(idx);
      last = elements as any;
      if (!ref) throw new Error(`click_element: index out of range: ${idx}`);
      const r = await runAgentBrowser(["--session", session, "click", ref]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || `click failed: ${ref}`);
      await runAgentBrowser(["--session", session, "wait", "--load", "networkidle"]).catch(() => null);
      last = await snapshotInteractive(session);
      continue;
    }

    if (kind === "input_text" || kind === "send_keys") {
      const idx = Number.isFinite(act?.index) ? Math.trunc(act.index as number) : 0;
      const text = String(act?.text ?? "");
      if (idx <= 0) continue;
      const { ref, elements } = await resolveRefByIndex(idx);
      last = elements as any;
      if (!ref) throw new Error(`input_text: index out of range: ${idx}`);
      const cmd = (kind === "input_text") ? "fill" : "type";
      const r = await runAgentBrowser(["--session", session, cmd, ref, text]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || `${cmd} failed: ${ref}`);
      last = await snapshotInteractive(session);
      continue;
    }
  }

  let capture: any = undefined;
  if (opts.captureTraffic || opts.learnOnFly) {
    const cap = await captureHarFromAgentBrowser({ session, includeTypes: ["xhr", "fetch"], maxRequests: 1200 });
    capture = {
      requestCount: cap.requestCount,
      har: cap.har as any,
      cookies: cap.cookies,
      localStorage: cap.localStorage,
      sessionStorage: cap.sessionStorage,
    };
  }

  const interactive = (last ?? []).map((e: any) => `[${e.index}] ${e.line}`);

  await runAgentBrowser(["--session", session, "close"]).catch(() => null);

  return { session, interactive, capture };
}

