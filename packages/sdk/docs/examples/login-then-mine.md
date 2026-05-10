# Example: Login Then Mine

Get authenticated access to a gated site, then capture and mine its routes.

```ts
import { Unbrowse } from "@unbrowse/sdk";

const u = new Unbrowse();

// Option A: interactive login (workstation).
await u.login({ url: "https://linkedin.com" });

// Option B: import cookies from your real Chrome profile (headless box).
await u.importAuth({
  url: "https://linkedin.com",
  browser: "chrome",
  chromeProfile: "Default",
});

// Now resolve normally. Auth is in place for the runtime.
const resolved = await u.resolve({
  intent: "my recent direct messages",
  url: "https://www.linkedin.com/messaging/",
});

const pick = resolved.available_endpoints?.[0];
if (!pick) {
  const handoff = resolved.next_actions?.[0];
  // If auth didn't stick, the handoff command will say so.
  throw new Error(handoff?.why ?? "no shortlist; auth may not have stuck");
}

const r = await u.execute(pick.endpoint_id, {
  contextUrl: "https://www.linkedin.com/messaging/",
  projection: { raw: true },
});

if (r.trace.success) {
  console.log(r.result);
} else {
  console.error(r.trace.error);
}
```

## Notes

- Auth is cached in the local Kuri profile per domain. You don't need to re-login between resolve calls.
- The captured skill, on publish, has auth headers stripped. Marketplace replays of LinkedIn skills require the replay-er to provide their own auth.
- For long-running workers, prefer `importAuth` from a profile that's actually being used by a human. Single-purpose throwaway profiles tend to lose sessions to vendor security checks.
