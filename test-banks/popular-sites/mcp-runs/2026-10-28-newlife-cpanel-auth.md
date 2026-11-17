# New Life cPanel auth check — 2026-10-28

This site-specific test is outside the 400-site inventory. The node browser
opened the cPanel login form at `https://newlife.org.sg:2083/`, filled the
stored Vault login, and reached the authenticated cPanel dashboard. The
dashboard showed File Manager, Email Accounts, Domains, Metrics, and Tools.
No OTP field appeared during login. macOS required the owner to approve the
node's Keychain access before the password fill completed.

I followed the observed Domains link through `unbrowse_browse`. The Domains
page stayed on HTTPS port 2083, displayed its controls, and did not show a
login form. A separate unauthenticated HTTP GET to the same page with the
session path segment removed returned a login form, not the Domains heading.
No domain or account setting was changed.

This confirms guest gating, Vault login, and a protected browser read. An
`unbrowse_do` learned/replayed route was not attempted because cPanel places a
session identifier in page URLs, which the current route recorder may store.
The authenticated node browser session remains open; logout and session expiry
were not tested. The [metadata](2026-10-28-newlife-cpanel-auth.json) contains
no credential, cookie, or session URL.

The test exposed a separate local bug: a Vault reference for a non-default
port was parsed as the wrong account and the browser check discarded the port.
The local fix now keeps and verifies the HTTPS port. Regression tests pass; it
is tracked in [issue #26](https://github.com/unbrowse-ai/unbrowse-core/issues/26).
