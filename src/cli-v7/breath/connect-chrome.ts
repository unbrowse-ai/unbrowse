import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
async function cmdConnectChrome(): Promise<void> {
  const { execSync, spawn: spawnProc } = require("child_process");
  
  // Check if Chrome already has CDP
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const data = await res.json() as { "User-Agent"?: string };
      if (!data["User-Agent"]?.includes("Headless")) {
        console.log("Your Chrome is already connected with CDP on port 9222.");
        console.log("Browse commands will use your real browser with all your sessions.");
        return;
      }
    }
  } catch { /* not running */ }

  // Kill any Kuri-managed Chrome
  try { execSync("pkill -f kuri/chrome-profile", { stdio: "ignore" }); } catch {}

  // Quit Chrome fully — can't add debugging port to running instance
  console.log("Quitting Chrome to relaunch with remote debugging...");
  if (process.platform === "darwin") {
    try { execSync('osascript -e "quit app \"Google Chrome\""', { stdio: "ignore", timeout: 5000 }); } catch {}
  } else {
    try { execSync("pkill -f chrome", { stdio: "ignore" }); } catch {}
  }
  await new Promise(r => setTimeout(r, 2000));

  console.log("Launching Chrome with remote debugging on port 9222...");
  if (process.platform === "darwin") {
    spawnProc("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", 
      ["--remote-debugging-port=9222", "--no-first-run", "--no-default-browser-check"],
      { stdio: "ignore", detached: true }).unref();
  } else {
    spawnProc("google-chrome", ["--remote-debugging-port=9222"], { stdio: "ignore", detached: true }).unref();
  }

  // Wait for CDP
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        console.log("Connected. Your real Chrome is now available for browse commands.");
        console.log("All your logged-in sessions (LinkedIn, X, etc.) will work.");
        console.log('Run: unbrowse go "https://linkedin.com/feed/"');
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  console.error("Could not connect to Chrome. Make sure all Chrome windows are closed and try again.");
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdConnectChrome();
}
