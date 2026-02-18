import { runAgentBrowser } from "../../agent-browser/runner.js";
import { captureHarFromAgentBrowser } from "../../agent-browser/har.js";

export async function loginWithAgentBrowser(opts: {
  loginUrl: string;
  formFields?: Record<string, string>;
  submitSelector?: string;
  captureUrls?: string[];
}): Promise<{
  session: string;
  baseUrl: string;
  requestCount: number;
  har: { log: { entries: any[] } };
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}> {
  const session = `unbrowse-${Date.now()}`;
  const baseUrl = (() => {
    try { return new URL(opts.loginUrl).origin; } catch { return ""; }
  })();

  const openRes = await runAgentBrowser(["--session", session, "open", opts.loginUrl]);
  if (openRes.code !== 0) {
    throw new Error(openRes.stderr || openRes.stdout || "agent-browser open failed");
  }

  for (const [selector, value] of Object.entries(opts.formFields ?? {})) {
    const r = await runAgentBrowser(["--session", session, "fill", selector, String(value)]);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || `fill failed: ${selector}`);
  }

  if (opts.submitSelector) {
    const r = await runAgentBrowser(["--session", session, "click", opts.submitSelector]);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || `click failed: ${opts.submitSelector}`);
  }

  await runAgentBrowser(["--session", session, "wait", "--load", "networkidle"]).catch(() => null);

  for (const u of (opts.captureUrls ?? [])) {
    await runAgentBrowser(["--session", session, "open", u]).catch(() => null);
    await runAgentBrowser(["--session", session, "wait", "--load", "networkidle"]).catch(() => null);
  }

  const cap = await captureHarFromAgentBrowser({ session, includeTypes: ["xhr", "fetch"], maxRequests: 800 });

  // Best-effort close. (If user wants to keep session open, we can add a flag later.)
  await runAgentBrowser(["--session", session, "close"]).catch(() => null);

  return {
    session,
    baseUrl,
    requestCount: cap.requestCount,
    har: cap.har as any,
    cookies: cap.cookies,
    localStorage: cap.localStorage,
    sessionStorage: cap.sessionStorage,
  };
}

