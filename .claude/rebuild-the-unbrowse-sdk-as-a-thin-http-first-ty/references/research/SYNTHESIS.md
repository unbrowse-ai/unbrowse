# SDK design synthesis — converged shape for @unbrowse/sdk

Citations: [resend](./resend.md), [openai](./openai.md), [replicate](./replicate.md), [stripe](./stripe.md), [vercel-ai](./vercel-ai.md).

## Converged pattern (what all four canonical SDKs share)

| Surface | Resend | OpenAI | Replicate | Stripe | **unbrowse** |
|---|---|---|---|---|---|
| Constructor | `new Resend(key)` | `new OpenAI({apiKey})` | `new Replicate({auth})` | `new Stripe(key, cfg)` | `new Unbrowse({apiKey})` |
| Env fallback | `RESEND_API_KEY` | `OPENAI_API_KEY` | `REPLICATE_API_TOKEN` | n/a | `UNBROWSE_API_KEY` |
| Base URL env | `RESEND_BASE_URL` | `OPENAI_BASE_URL` | `baseUrl` opt | n/a | `UNBROWSE_BASE_URL` |
| Auto-retry | no | yes (2) | no | yes (2) | yes (2) |
| Idempotency | yes (manual) | n/a | n/a | yes (auto) | yes (auto on execute) |
| Throws on err | no (`{data,error}`) | yes (typed) | yes (typed) | yes (typed) | yes (typed) |
| Custom fetch | global only | injectable | injectable | n/a | injectable |
| Edge runtime | yes | yes | yes (CI proven) | partial | required |
| Resource ns | yes (.emails.) | yes (.chat.) | yes (.predictions.) | yes (.customers.) | flat + `.account.*` `.keys.*` |
| Request ID | n/a | `_request_id` | n/a | n/a | `_request_id` |

## The @unbrowse/sdk v7 surface (decided)

```ts
import { Unbrowse, UnbrowseRateLimitError } from "@unbrowse/sdk";

const ub = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });

// flat top-level
const result = await ub.resolve({ intent: "search hackernews for AI papers" });
const data = await ub.execute({ endpoint_id: result.endpoints[0].id, params: {q: "agents"} });
const hits = await ub.search({ intent: "github trending repos", domain: "github.com" });
const ok = await ub.health();

// grouped
const usage = await ub.account.usage();
const keys = await ub.keys.list();
const newKey = await ub.keys.create({ name: "prod" });
```

## Decisions (load-bearing)

1. **Throw, don't return `{data, error}`.** Matches OpenAI/Stripe/Replicate. Lower agent friction.
2. **Object-form constructor.** Matches OpenAI. Extensible without breaking changes.
3. **Auto-retry on 429/5xx/connection** with exponential backoff + jitter. Default 2. Per-request override.
4. **Idempotency-Key auto-set on POST /v1/execute** so network-error retries don't double-charge agents on x402.
5. **`fetch` injectable** as middleware (Vercel AI lesson).
6. **Edge-runtime CI lane** from day one (node, browser, workerd).
7. **`_request_id` on every response** from `x-request-id` server header.
8. **Typed error hierarchy** (Unbrowse* prefix, mirrors OpenAI shape).
9. **Zero runtime deps.** Native fetch only. (Sponsor wallet signing moves to `@unbrowse/sdk/x402` subpath, optional.)
10. **`@unbrowse/local` separate package** holds the binary-spawn + Kuri runtime path. The default `@unbrowse/sdk` does NOT pull it in.

## Error class hierarchy (codified)

```
UnbrowseError                          (base; everything inherits)
├─ UnbrowseAPIError                    (base for any 4xx/5xx with body)
│  ├─ UnbrowseAuthenticationError      (401)
│  ├─ UnbrowsePaymentRequiredError     (402 — x402 hint, sponsor exhausted)
│  ├─ UnbrowsePermissionError          (403)
│  ├─ UnbrowseNotFoundError            (404)
│  ├─ UnbrowseBadRequestError          (400)
│  ├─ UnbrowseRateLimitError           (429)
│  └─ UnbrowseServerError              (5xx)
└─ UnbrowseConnectionError             (network)
   └─ UnbrowseTimeoutError             (request timed out)
```

Existing classes from `packages/sdk/src/errors.ts` (`PaymentRequiredError`, `RuntimeUnavailableError`, `SponsorExhaustedError`, `UnbrowseApiError`) map onto this hierarchy — the migration is rename + extend.
