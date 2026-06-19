# Credential Sovereignty

Most agent tooling treats authentication as a wall: hit a gated site, fail, and ask the
user to paste a token or sign in again. Unbrowse treats it as something the user already
owns and can lend to the agent on their own terms.

## The user is already logged in

A person's real sessions live in their daily-driver browser. Unbrowse reads them directly
from the local browser stores — no fresh login, no copy-pasting tokens:

- It sweeps the whole Chromium family (Chrome, Dia, Arc, Brave, Edge, Vivaldi, Opera,
  Chromium) plus Firefox, not just one hardcoded browser.
- It decrypts each browser's own keychain-encrypted cookie store (every Chromium browser
  has a distinct `<Browser> Safe Storage` key) from a copy of the DB, so the browser does
  not have to be closed.
- When several browsers have a session for the same site, it picks the richest one — the
  profile with the most session-grade (httpOnly + secure) cookies — because that is the
  one actually logged in.

The result: if you are signed into a site in any of your browsers, the agent can act as
you on that site without a capture step. The same idea extends past cookies to the other
request material a logged-in session carries (CSRF tokens, bearer headers, the auth
inventory a route needs).

## From "stored in the keychain" to "bound to an identity"

Harvested credentials still have a custody problem: a cookie in the OS keychain is bound
to one machine and one user account, with no expiry the agent understands and no way to
lend it across devices safely. The next layer fixes custody by binding a captured
credential to the user's **public-key identity** rather than to a disk location.

The shape:

1. **Capture or harvest** the session as today (browser sweep, or an explicit auth flow).
2. **Bind** it to the user's wallet / public-key identity instead of a bare keychain entry.
3. **Commit, don't store.** A commitment to the credential — not the secret — lands on the
   ledger, carrying an explicit expiry. The ledger row proves *that* a valid session exists
   and when it lapses, without ever exposing the secret.
4. **Unlock at replay.** When a route needs the credential, the agent resolves the pointer
   and unlocks the secret with a wallet signature. No signature, no secret; past expiry,
   the row is dead and the agent falls back to a fresh capture.

This makes a session a first-class, portable, revocable, expiring asset: the user grants an
agent the right to act as them on a site, the grant is witnessed and time-boxed on the
ledger, and it can be carried across devices because custody follows the key, not the disk.
It composes with the same payment rail that gates shared routes — the wallet that settles a
route fee is the wallet that unlocks the credential bound to its identity.

## Why this matters

- **No re-login tax.** The most common agent failure ("auth_required") disappears for any
  site the user is already signed into — the credential is read from the live browser.
- **Custody stays with the user.** Secrets are never published; only commitments with
  expiries are. Revocation is a ledger event, not a password reset.
- **Portable identity.** Because custody follows the public key, a grant made on a laptop
  can be honored by an agent running anywhere the user authorizes, without copying secrets.

## Status

The browser harvest (multi-browser sweep, per-browser keychain decryption, richest-session
selection) is live in the runtime. The ledger-bound, wallet-unlocked credential layer is the
next build on top of the public-key identity root; this section is the design it targets.
