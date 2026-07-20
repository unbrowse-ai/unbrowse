# Security Architecture

This page describes the security model for Unbrowse 11.1.1.

## Trust Boundaries

| Boundary | Sensitive material | Control |
| --- | --- | --- |
| User to Unbrowse account | API key | authenticated transport, key hashing, rotation, and revocation |
| Browser to local runtime | session cookies and request headers | local capture and encrypted credential storage |
| Local runtime to shared catalogue | route definitions and schemas | secret filtering and reference-only auth metadata |
| SDK to API | request parameters and account identity | API-key authentication, validation, timeouts, and structured errors |
| Account to credit ledger | granted, earned, and consumed credits | server-side accounting tied to the authenticated account |

## Authentication

The public SDK accepts an Unbrowse API key. Anonymous requests may use endpoints that explicitly permit them; account and metered operations require a valid key. The API never treats a website credential as Unbrowse account identity.

## Credential Vault

Site credentials are stored locally and addressed through auth profiles. Learned skills may declare that a route needs cookies, headers, or another auth method, but they must not embed the secret values. During replay, the local runtime resolves the matching profile and injects the required material into the outbound request.

## Publication Controls

Before a learned skill is published, the runtime removes or rejects credential values, sensitive headers, private response data, and unsafe local references. Publication should fail closed when the sanitizer cannot establish a safe output.

## Execution Controls

- validate URLs, methods, parameters, and response sizes
- enforce timeouts and bounded retries
- require deliberate confirmation for irreversible actions
- preserve origin and authorization boundaries
- return structured failures instead of masking an unsuccessful action
- keep observability useful without logging credentials or full private payloads

## Credits

Metered operations debit the authenticated account's credit ledger. Credit state is reported as granted, earned, consumed, and available balances. An insufficient balance produces a structured insufficient-credits error; the SDK does not perform an alternate payment or identity flow.

## Verification

Route verification measures replay health, expected schema, freshness, and drift. It is a product reliability signal, not proof that arbitrary state-changing behavior is safe. Applications retain responsibility for confirmation and policy decisions around consequential actions.

## Related Documentation

- [Authentication](./AUTH.md)
- [Privacy](./PRIVACY.md)
- [Backend](./BACKEND.md)
- [Test specifications](./TEST-SPECS.md)
