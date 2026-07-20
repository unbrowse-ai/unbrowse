# Backend

The backend owns the shared route graph and account ledger. The local runtime
owns browsing, site credentials, and direct execution.

## Main API groups

| Group | Examples |
|---|---|
| Resolution | `POST /v1/resolve`, `POST /v1/search` |
| Execution | `POST /v1/execute`, `POST /v1/proxy` |
| Accounts | `GET /v1/account/me`, `/keys`, `/credits` |
| Publishing | skill submission, review, visibility, freshness |
| Operations | health, version, metrics, audit events |

## Credits

Credits are stored as integer micro-units (`*_uc`) to avoid floating-point
accounting. `1_000_000` units equal one USD-denominated credit. The user ledger
tracks granted, earned, consumed, and available units. Admission and debit must
be atomic and idempotency keys prevent a retried execute from being counted
twice.

## Route graph

Published contracts contain reusable request shapes, parameter schemas,
provenance, and freshness signals. They do not contain captured response bodies
or authentication material. Ranking uses intent similarity plus reliability and
freshness evidence; an empty result is returned honestly when no candidate is
safe to execute.
