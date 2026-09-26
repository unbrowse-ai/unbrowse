# Logins and the vault

Unbrowse keeps logins in its password manager. Agents, the CLI and the SDK never see a password.

## Saving a login

- In the console at `/app/vault`, directly.
- From a one-time link. When a run or autofill needs a login nobody saved, the service returns a
  `/app/vault-request/…` link. The CLI opens it (agents can make one on demand with the MCP tool
  `unbrowse.credentials.request`); the person signs in to Unbrowse and saves the username or email, password and optional
  2FA seed. Agents wait with `unbrowse.credentials.status`, then repeat the call.
- CSV import from Chrome, Bitwarden, 1Password, LastPass, Firefox, Apple and Dashlane in the
  console.

## Using a login

- **Cloud browser:** `unbrowse.browse.act` with `action: "autofill"` fills the page's login form
  (username or email, password, 2FA code). `fill` on one ref with `vault: "password"` fills
  one field. Snapshots show `[from vault]`, never the value.
- **Replay:** learned capabilities that sign in take the login from the vault themselves. If a
  browserless run hits a login wall on a site with a saved login, Unbrowse signs in once in the
  browser, caches the session, and keeps replaying without one until it expires.
- **Sessions are kept.** Once a browse session is signed in, later runs and sessions on that site
  start signed in, so an emailed code is needed once. A logged-out session is dropped.

`unbrowse logins` lists saved logins as masked hints: site, label, which fields are saved.

## Custody

| Vault | Keys | Use |
|---|---|---|
| Agent vault | Server-sealed: AES-256-GCM per item, per-workspace data key wrapped by a key-encryption key, bound to the item | Unattended runs |
| Private vault (rolling out) | Zero-knowledge: keys derived in your browser (PBKDF2 650k ⊕ HKDF of a Secret Key), AES-256-GCM per item | Logins the service cannot read until you release them |

The owner releases Private-vault logins to runs for 1 hour, 8 hours or for good. Recorded traces
and evidence are scrubbed of typed secrets. Passwords typed in free text to the chat are redacted.

## Rules for agents

- Never ask the user for a password. Never pass one as a tool argument.
- On a login page, `autofill`. No login saved → give the person the save-login link and wait.
- A read-only route you teach may be shared to the public registry; logins and writes never are.
