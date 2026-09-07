# API Reference

TypeScript surface of `@unbrowse/sdk`. All methods are async and throw `UnbrowseApiError` on non-2xx responses.

## Core methods

| Method | HTTP | Doc |
|---|---|---|
| `resolve(input)` | `POST /v1/intent/resolve` | [resolve](./resolve.md) |
| `execute(skill, input?)` | `POST /v1/skills/:id/execute` | [execute](./execute.md) |
| `getSkill(id)` | `GET /v1/skills/:id` | [execute](./execute.md) |
| `login(input)` | `POST /v1/auth/login` | [auth](./auth.md) |
| `importAuth(input)` | `POST /v1/auth/steal` | [auth](./auth.md) |
| `search(input)` | `POST /v1/search` | inline |
| `searchDomain(input)` | `POST /v1/search/domain` | inline |
| `feedback(input)` | `POST /v1/feedback` | inline |
| `stats()` | `GET /v1/stats` | inline |
| `health()` | `GET /health` | inline |

## Earnings surface (added in 6.9.69423)

| Method | HTTP | Doc |
|---|---|---|
| `dashboard()` | `GET /v1/dashboard/me` | [rewards](./rewards.md) |
| `dashboardByWallet(addr)` | `GET /v1/dashboard/wallet/:walletAddress` | [rewards](./rewards.md) |
| `creatorTransactions(id)` | `GET /v1/transactions/creator/:agentId` | [rewards](./rewards.md) |
| `indexerAttribution(id)` | `GET /v1/attribution/indexer/:indexerId` | [rewards](./rewards.md) |

## Helpers

| Helper | Use |
|---|---|
| `Unbrowse.paramsFromInputSpec(pick.input_params)` | Build a default `params` object from an `AvailableEndpoint`'s declared inputs. |
| `u.request<T>(method, path, body?)` | Escape hatch for any `/v1/*` route not yet typed. |

## Errors

```ts
import { UnbrowseApiError } from "@unbrowse/sdk";

try {
  await u.resolve({ intent, url });
} catch (e) {
  if (e instanceof UnbrowseApiError) {
    console.error(e.status, e.path, e.data);
  }
}
```

## Types

See `packages/sdk/src/contracts.ts` for the full set: `ResolveInput`, `ResolveResponse`, `ExecuteInput`, `ExecuteResponse`, `SkillManifest`, `EndpointDescriptor`, `AvailableEndpoint`, `Dashboard`, `CreatorTransactionsResponse`, `AttributionLedger`, etc.
