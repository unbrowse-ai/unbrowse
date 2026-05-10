# Auth: `login` and `importAuth`

Two paths to give Unbrowse access to gated sites.

## `login` (interactive)

```ts
await u.login({ url: "https://linkedin.com" });
// Opens a browser window for the user to complete auth.
// Cookies/session are persisted in the local Kuri profile.
```

Use this on dev workstations and demo flows. The runtime's headless default is overridden for this single call so the user can actually log in.

## `importAuth` (non-interactive)

Reuses cookies from a real Chrome / Firefox / Chromium profile already present on the box.

```ts
await u.importAuth({
  url: "https://linkedin.com",
  browser: "chrome",
  chromeProfile: "Default",
});
```

Full options:

```ts
interface StealAuthInput {
  url: string;
  browser?: "auto" | "chrome" | "firefox" | "chromium";
  chromeProfile?: string;
  firefoxProfile?: string;
  chromiumProfile?: string;
  chromiumUserDataDir?: string;
  chromiumCookieDbPath?: string;
  safeStorageService?: string;
  browserName?: string;
}
```

## `stealAuth` (alias)

`u.stealAuth(input)` is an alias for `u.importAuth(input)`.

## When to use which

| | `login` | `importAuth` |
|---|---|---|
| Interactive workstation | yes | works, but extra step |
| Headless server / CI | no | yes |
| Sites with MFA/passkeys | yes | only if you've already logged in once on a real browser |
| Per-call freshness | yes | depends on browser session staying alive |

## Privacy boundary

Imported cookies live only in the local runtime's Kuri profile. They never publish to the marketplace. Captured skills strip auth headers before publish.
