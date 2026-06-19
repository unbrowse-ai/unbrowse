// Witness for docs/whitepaper/credential-sovereignty.md:
// the runtime harvests a live logged-in session from the user's daily-driver
// browser (any Chromium-family browser or Firefox), WITHOUT a fresh login.
// Exit 0 iff a session-grade credential set is found for the domain.
// Usage: bun scripts/witness/browser-cred-harvest.mjs [domain]
import { scanAllBrowserSessions, findBestBrowserSession } from "../../src/auth/browser-cookies.js";
const domain = process.argv[2] || "x.com";
const sessions = scanAllBrowserSessions(domain);
for (const s of sessions) console.log(`  ${s.browser}: ${s.cookies.length} cookies (${s.sessionCookies} session-grade)`);
const best = findBestBrowserSession(domain);
if (!best || best.sessionCookies === 0) {
  console.log(`NO live session for ${domain} in any browser (sign in to one first)`);
  process.exit(1);
}
// Report WHICH auth-shaped names are present — never their values.
const names = new Set(best.cookies.map((c) => c.name));
const authish = [...names].filter((n) => /auth|token|session|sid|csrf|ct0|sess/i.test(n));
console.log(`HARVESTED ${domain} from ${best.browser}: ${best.sessionCookies} session cookies; auth-shaped names: ${authish.join(", ") || "(none flagged)"}`);
process.exit(0);
