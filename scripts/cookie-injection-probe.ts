// A2 diagnostic primitive for bug B-023 (cookie injection bypassed at capture
// phase). Single-URL diagnostic — NOT a corpus iterator. Traces the four
// in-reach layers of the cookie pipeline and emits ONE structured JSON object
// to stdout. All logging goes to stderr; exits non-zero if any layer throws.
//
// Layers traced:
//   1. extract  — scanAllBrowserSessions(host) per-browser cookie counts
//   2. pick     — findBestBrowserSession(host) winning browser + count
//   3. inject   — importBrowserCookiesIntoTab(tabId, host) return value
//   4. jar      — broker.getCookies(tabId) post-inject jar size
//   5. wall     — (optional) navigate + snapshot + login-wall heuristic
//
// Layer "cookies_sent_on_navigation_request" requires a CDP
// Network.requestWillBeSent listener; that is out of scope for this seed
// (see TODO below). It is emitted as "not_observed" so the JSON shape is
// stable.

// Force headless + clean-room BEFORE any import that boots kuri so the probe
// never pops a visible window. Matches the pattern used by
// scripts/mcp-gate-parallel-collect.ts.
process.env.KURI_CLEAN_ROOM = "1";
process.env.HEADLESS = "true";
process.env.KURI_HEADLESS = "true";
process.env.UNBROWSE_FORCE_HEADLESS = "1";

import * as kuri from "../src/kuri/client.ts";
import {
  scanAllBrowserSessions,
  findBestBrowserSession,
} from "../src/auth/browser-cookies.ts";
import { importBrowserCookiesIntoTab } from "../src/auth/index.ts";

type LayerRow = { layer: string; count: number | string; notes?: string };

function log(msg: string): void {
  process.stderr.write(`[cookie-probe] ${msg}\n`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function profileNameOf(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function isLoginWall(currentUrl: string, snapshot: string): boolean {
  const url = currentUrl.toLowerCase();
  if (/\/(login|signin|sign-in|sso|auth|oauth)(\/|$|\?)/.test(url)) return true;
  if (/accounts\.google\.com\/.*\/(signin|servicelogin)/.test(url)) return true;
  if (/accounts\.youtube\.com\//.test(url)) return true;
  // Snapshot text is the a11y tree; first ~4KB usually contains the title /
  // top heading. Treat common login-wall labels as the signal.
  const head = snapshot.slice(0, 4096).toLowerCase();
  if (/\b(sign in|log in|sign-in|log-in)\b/.test(head)) return true;
  return false;
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    process.stderr.write(
      "usage: bun scripts/cookie-injection-probe.ts <url> [--browser=chrome|firefox|auto]\n",
    );
    process.exit(2);
  }
  // Note: --browser flag is parsed for future per-browser override; today the
  // scan covers all browsers and findBestBrowserSession picks. Stored on
  // output so a caller can see what they asked for.
  let browserPref: "chrome" | "firefox" | "auto" = "auto";
  for (const arg of process.argv.slice(3)) {
    const m = /^--browser=(chrome|firefox|auto)$/.exec(arg);
    if (m) browserPref = m[1] as typeof browserPref;
  }

  const host = hostOf(url);
  if (!host) {
    process.stderr.write(`invalid url: ${url}\n`);
    process.exit(2);
  }
  const profileName = profileNameOf(host);

  const layerBreakdown: LayerRow[] = [];
  const output: Record<string, unknown> = {
    url,
    intended_host: host,
    profile_name: profileName,
    browser_pref: browserPref,
    cookies_extracted_per_browser: {} as Record<string, number>,
    best_session_picked: null as null | {
      browser: string;
      domain_key: string;
      n_cookies: number;
      session_cookies: number;
    },
    cookies_passed_to_setcookie: 0,
    cookies_in_kuri_jar_post_setcookie: 0,
    cookies_sent_on_navigation_request: "not_observed" as number | string,
    captured_page_is_login_wall: false,
    layer_breakdown: layerBreakdown,
  };

  let tabId = "";
  try {
    // ---- Layer 1: scanAllBrowserSessions ----
    log(`Layer 1: scanAllBrowserSessions(${host})`);
    const sessions = scanAllBrowserSessions(host);
    const perBrowser: Record<string, number> = {};
    for (const s of sessions) perBrowser[s.browser] = s.cookies.length;
    output.cookies_extracted_per_browser = perBrowser;
    layerBreakdown.push({
      layer: "extract",
      count: sessions.reduce((a, s) => a + s.cookies.length, 0),
      notes: `${sessions.length} browser(s) with cookies for ${host}`,
    });

    // ---- Layer 2: findBestBrowserSession ----
    log(`Layer 2: findBestBrowserSession(${host})`);
    const best = findBestBrowserSession(host);
    if (best) {
      output.best_session_picked = {
        browser: best.browser,
        domain_key: host,
        n_cookies: best.cookies.length,
        session_cookies: best.sessionCookies,
      };
      layerBreakdown.push({
        layer: "pick",
        count: best.cookies.length,
        notes: `winner=${best.browser} session_cookies=${best.sessionCookies}`,
      });
    } else {
      layerBreakdown.push({
        layer: "pick",
        count: 0,
        notes: "no browser session returned cookies",
      });
    }

    // ---- Boot kuri broker + get a tab ----
    log("starting kuri broker (headless)");
    const broker = kuri.getKuriClient();
    await broker.start();
    log("creating new tab (about:blank)");
    tabId = await broker.newTab("about:blank");
    if (!tabId) throw new Error("failed to create kuri tab");
    log(`tab_id=${tabId}`);

    // ---- Layer 3: importBrowserCookiesIntoTab ----
    log(`Layer 3: importBrowserCookiesIntoTab(${tabId}, ${host})`);
    const passed = await importBrowserCookiesIntoTab(tabId, host);
    output.cookies_passed_to_setcookie = passed;
    layerBreakdown.push({
      layer: "inject",
      count: passed,
      notes: "importBrowserCookiesIntoTab return value (== successful setCookie calls)",
    });

    // ---- Layer 4: broker.getCookies(tabId) ----
    log(`Layer 4: broker.getCookies(${tabId})`);
    const jarCookies = await broker.getCookies(tabId);
    // Filter to cookies actually in-scope for the host so the count is
    // comparable to the inject count (which only injected host-matching).
    const jarForHost = jarCookies.filter((c) => {
      const d = (c.domain || "").replace(/^\./, "");
      return host === d || host.endsWith(`.${d}`) || d.endsWith(host);
    });
    output.cookies_in_kuri_jar_post_setcookie = jarForHost.length;
    layerBreakdown.push({
      layer: "jar",
      count: jarForHost.length,
      notes: `${jarCookies.length} total in tab jar, ${jarForHost.length} match host=${host}`,
    });

    // ---- Layer 5 (optional): navigate + login-wall heuristic ----
    // TODO: cookies_sent_on_navigation_request requires a CDP
    // Network.requestWillBeSent event listener (attach via the same CDP
    // ws_url already resolved by setCookieViaCDP). Out of scope for this
    // seed; emitted as "not_observed".
    try {
      log(`navigating to ${url}`);
      await broker.navigate(tabId, url);
      // Brief settle so SPAs render their first paint / login wall.
      await new Promise((r) => setTimeout(r, 1500));
      const currentUrl = await broker.getCurrentUrl(tabId);
      const snap = await broker.snapshot(tabId);
      output.captured_page_is_login_wall = isLoginWall(currentUrl, snap);
      layerBreakdown.push({
        layer: "wall",
        count: output.captured_page_is_login_wall ? 1 : 0,
        notes: `current_url=${currentUrl.slice(0, 200)} snap_bytes=${snap.length}`,
      });
    } catch (err) {
      layerBreakdown.push({
        layer: "wall",
        count: "error",
        notes: `navigation/snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    process.stdout.write(JSON.stringify(output) + "\n");
  } catch (err) {
    process.stderr.write(
      `[cookie-probe] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    // Still emit whatever we collected so the caller has partial evidence.
    output["error"] = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(1);
  } finally {
    // Best-effort cleanup; never throw from finally.
    try {
      if (tabId) {
        log(`closing tab ${tabId}`);
        const broker = kuri.getKuriClient();
        await broker.closeTab(tabId);
      }
    } catch (err) {
      log(`tab close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

await main();
