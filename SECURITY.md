# Security & Trust Model

Unbrowse is a **local-first automation tool** that runs entirely on your machine. This document explains what data it accesses, why, and how you control it.

## TL;DR

- **All data stays local** — nothing is sent to external servers (except marketplace if you opt-in)
- **You control what's enabled** — sensitive features require explicit configuration
- **Open source** — audit the code yourself: every capability is documented below

## What Unbrowse Can Access

### 1. Chrome Cookies (`src/chrome-cookies.ts`)

**What:** Reads cookies from Chrome's local database and decrypts them using macOS Keychain.

**Why:** To reuse your existing authenticated sessions instead of requiring you to log in again. When you're already logged into a site in Chrome, Unbrowse can use that session.

**When used:** Only when you call `unbrowse_capture` or `unbrowse_login` on a site where you're already logged in.

**Where data goes:** Cookies are stored locally in `~/.openclaw/skills/<service>/auth.json`. Never transmitted externally.

**Opt-out:** Don't use Chrome session features. Use `unbrowse_login` with manual credentials instead.

---

### 2. OTP/2FA Code Reading (`src/otp-watcher.ts`)

**What:** Monitors clipboard, iMessage, Notification Center, and Mail.app for OTP codes.

**Why:** To auto-fill 2FA codes during automated login flows, eliminating manual copy-paste.

**When used:** Only during `unbrowse_login` when a site requires 2FA. You'll see a prompt that it's waiting for an OTP.

**Where data goes:** OTP codes are used immediately for form filling. Not stored.

**Opt-out:** Set `credentialSource: "none"` in config. You'll need to manually enter OTP codes.

---

### 3. Credential Access (`src/credential-providers.ts`)

**What:** Reads passwords from macOS Keychain or 1Password CLI.

**Why:** To auto-fill login forms without you manually typing credentials.

**When used:** Only when you configure `credentialSource: "keychain"` or `"1password"` AND call `unbrowse_login`.

**Where data goes:** Credentials are used for form filling only. Never stored in skill files.

**Default:** `credentialSource: "none"` — **disabled by default**. You must explicitly enable this.

---

### 4. Desktop Automation (`src/desktop-automation.ts`)

**What:** Uses AppleScript to control apps (open, quit, type, click).

**Why:** Fallback for sites where browser automation fails (e.g., native app OAuth flows, Electron apps).

**When used:** Only when `unbrowse_desktop` tool is explicitly called. Not used automatically.

**Where data goes:** Actions are performed locally. Nothing transmitted.

**Opt-out:** Don't use the `unbrowse_desktop` tool. Browser-based capture works for most sites.

---

### 5. Auth Storage (`src/vault.ts`, `auth.json`)

**What:** Stores captured session tokens, cookies, and headers locally.

**Why:** So captured APIs can be replayed later without re-authenticating every time.

**Where data goes:**
- `~/.openclaw/skills/<service>/auth.json` — per-skill auth (tokens, cookies)
- `~/.openclaw/unbrowse/vault.db` — encrypted SQLite vault (optional)

**Security:**
- Files are local, not synced to cloud
- Vault uses SQLite encryption
- You can delete `auth.json` files anytime to revoke access

---

## What Unbrowse Does NOT Do

❌ **No telemetry** — We don't collect usage data or analytics  
❌ **No external transmission** — Auth stays on your machine (unless you publish to marketplace)  
❌ **No background processes** — Only runs when you invoke a tool  
❌ **No hidden capabilities** — All code is open source and documented  

---

## Marketplace & External Communication

The **only** external communication happens when you explicitly:

1. **Search marketplace** (`unbrowse_search`) — Queries `index.unbrowse.ai` for skill listings
2. **Publish a skill** (`unbrowse_publish`) — Uploads skill metadata (NOT your auth tokens)
3. **Download a skill** (`unbrowse_search install=...`) — Downloads skill package, pays via Solana

**Your credentials are NEVER uploaded.** When you publish a skill, only the API schema is shared — the actual auth tokens stay local.

---

## Feature Defaults

| Feature | Default | Requires |
|---------|---------|----------|
| Chrome cookie reading | ✅ Enabled | Calling capture/login tools |
| OTP auto-fill | ✅ Enabled | OTP being sent during login |
| Keychain/1Password | ❌ Disabled | `credentialSource` config |
| Desktop automation | ❌ Disabled | Explicit `unbrowse_desktop` call |
| Marketplace publish | ❌ Disabled | Explicit `unbrowse_publish` call |

---

## Recommended Security Practices

1. **Review skill auth files** — Check `~/.openclaw/skills/*/auth.json` periodically
2. **Rotate tokens** — Delete `auth.json` and recapture if a service token is compromised
3. **Use separate Chrome profile** — Run captures in a dedicated profile if concerned
4. **Audit before publish** — Always check what's in a skill before publishing to marketplace

---

## Threat Model

Unbrowse is designed for **personal automation** where:

- You trust your local machine
- You want your AI agent to access sites as you (not as a separate identity)
- You accept that auth tokens on disk are as secure as your disk encryption

**Not designed for:**
- Multi-tenant/shared machine environments
- Corporate compliance-heavy environments
- Scenarios where you distrust the software running on your machine

---

## Reporting Security Issues

Found a vulnerability? Please report responsibly:

1. **Email:** security@getfoundry.app
2. **GitHub:** Open a private security advisory
3. **Do not** post exploits publicly before we've patched

---

## Code Audit

All "scary" capabilities are in clearly named files:

```
src/chrome-cookies.ts      — Cookie decryption
src/otp-watcher.ts         — OTP monitoring
src/credential-providers.ts — Keychain/1Password
src/desktop-automation.ts  — AppleScript
src/vault.ts               — Auth storage
```

We encourage code review. If something looks unsafe, open an issue or PR.
