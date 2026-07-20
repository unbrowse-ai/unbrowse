# Credential Sovereignty

Unbrowse treats a signed-in browser session as user-owned context that an agent may use locally, under the user's control.

## Local by Default

Unbrowse can capture authenticated requests from a browser session and store the reusable auth material in its local credential vault. Published skills contain auth requirements and references, never the user's secret values.

## Current Identity Model

Cloud account access uses an Unbrowse API key. Local site credentials are separate from account identity: they remain on the user's machine and are injected only when a matching route is executed.

This separation keeps the model understandable:

- the API key identifies the Unbrowse account
- the credit ledger records granted, earned, and consumed credits
- the local vault holds site-specific credentials
- shared skills describe how authentication is applied without publishing secrets

## Direction

Portable, revocable, time-limited grants remain a useful research direction. They are not part of the current public SDK contract and should not be presented as shipped behavior.
