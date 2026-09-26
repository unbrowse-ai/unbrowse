# Credential Sovereignty

Most agent tooling treats a login as a wall: the agent fails, or asks the user to paste a password into the chat. Unbrowse keeps logins in a password manager the model never reads, and fills them into the page itself.

All of this runs in the hosted service. The client in this repo never handles a website password.

## The rule

The agent never sees a password and never types one.

- On a login page the agent calls `unbrowse.browse.act { action: "autofill" }`, or fills one field with `vault: "username" | "email" | "password" | "totp"`.
- The value goes into the page. Snapshots show `[from vault]`.
- `unbrowse.credentials.list` shows saved logins as masked hints only.
- Agents see `vault://` references, never values.
- Typed secrets are scrubbed from recorded traces and evidence. Passwords typed into chat are redacted.

## When no login is saved

The agent does not ask for the password. The service creates a one-time save-login link (`/app/vault-request/…`). Only the workspace owner can open it.

- MCP clients that support URL elicitation get it as error `-32042` and open it.
- Other clients (CLIs, REST) get the link with an instruction to open it in the user's browser.
- The user signs in to Unbrowse and saves the login there. The agent waits with `unbrowse.credentials.status` and retries.

## Two vaults

Unbrowse follows 1Password's model.

**Agent vault.** Server-sealed so agents can use it unattended. Each login is AES-256-GCM ciphertext under a per-workspace key, wrapped by a master key and bound to its record. The same password sealed twice gives different ciphertext. A ciphertext moved to another record or workspace will not open.

**Private vault.** Zero-knowledge. The key is derived in the owner's browser from a master password and a 128-bit Secret Key (two-secret key derivation: PBKDF2-SHA256 at 650,000 iterations, combined with HKDF of the Secret Key). Items are AES-256-GCM sealed in the browser. The server stores ciphertext plus site and label, nothing that can open it. The owner can release a Private login to agents for 1 hour, 8 hours or for good.

The Private vault is the newest piece. Its acceptance check is still open.

## Import

Logins import from CSV exports of Chrome/Google, Bitwarden, 1Password, LastPass, Firefox, Apple Passwords and Dashlane, or a generic url/username/password file. 2FA seeds import from a raw seed or an `otpauth://` link.

## Sign-in on replay

A learned capability that signs in takes the username and password from the vault by itself.

If a browserless read hits a login wall (401, 403, or a login page) on a site with a saved login:

1. The service signs in once in its browser, filling the form from the vault.
2. It captures the session and retries the read over HTTP.
3. It caches the session. Later runs start signed in and skip the login step.

A login that needs an emailed code needs it once. When the kept session expires or is logged out, `unbrowse.sites` says so, and the next run signs in again.

## What never leaves the workspace

- Login-backed capabilities are never shared to the public registry.
- Registry entries are stripped of cookies, authorization and session values.
- Compiled capability packages hold placeholders, never captured session values.
- Each user's logins, sessions and capabilities live in that user's own partition.

## Status

| Piece | Status |
| --- | --- |
| Vault sealing, survives restarts, nothing plaintext stored | Shipped |
| Password manager with autofill, masked hints, save-login links | Shipped, check open |
| CSV import | Shipped, check open |
| Auto sign-in on replay and session reuse | Shipped, check open |
| Zero-knowledge Private vault | Newest; check open |

## Direction, not shipped

Earlier drafts described binding a session to a user's public-key identity, committing it to a ledger with an expiry, and unlocking it with a wallet signature at replay. None of that exists in the current service. See [Coming Soon](./coming-soon.md).
