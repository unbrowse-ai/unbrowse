# `resolve`

The primary entry point. Takes an `intent` plus optional `url`/`params`/`context` and returns the orchestrated result, plus a ranked shortlist of callable endpoints.

```ts
u.resolve(input: ResolveInput, options?: RequestOptions): Promise<ResolveResponse>
```

## Input

```ts
interface ResolveInput {
  intent: string;
  url?: string;
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
  projection?: ProjectionOptions;
  confirmUnsafe?: boolean;
  confirmThirdPartyTerms?: boolean;
  dryRun?: boolean;
  forceCapture?: boolean;
}
```

## Output

From `packages/sdk/src/contracts.ts`:

```ts
interface ResolveResponse {
  result: unknown;                              // the orchestrated result, if one was produced
  trace: ExecutionTrace;                        // success + status_code + error live here
  source: "marketplace" | "live-capture" | "dom-fallback" | "first-pass";
  skill?: SkillManifest;                        // the skill the runtime selected
  timing?: OrchestrationTiming;
  available_endpoints?: AvailableEndpoint[];    // RANKED shortlist for the agent to pick from
  impact?: AgentImpact;                         // tokens/ms saved
  next_actions?: AgentNextAction[];             // actionable handoffs (each has command + why)
  [key: string]: unknown;                       // forward-compatible: extra fields show up here
}
```

## The two-tool-call contract

Resolve returns a **shortlist** in `available_endpoints`. The calling LLM picks; you call `execute`. **Never auto-execute** unless you've explicitly opted in:

```ts
const resolved = await u.resolve({ intent, url });

const pick = resolved.available_endpoints?.[0];
if (!pick) {
  // No shortlist — inspect resolved.next_actions for the recovery handoff.
  return resolved.next_actions?.[0];
}

const result = await u.execute(pick.endpoint_id, {
  params: paramsFromInputSpec(pick.input_params),
});
```

This is the heart of why Unbrowse feels reasonable to an LLM: it sees the candidate set, picks based on richer signal than we have, and you stay in control.

## Reading `available_endpoints`

Each `AvailableEndpoint` carries:

- `endpoint_id` (always present) — use this for `execute`.
- `score`, `method`, `url_template`, `description` — ranking signal.
- `schema_summary`, `example_fields` — hints about response shape.
- `input_params: Array<{ key, type?, required?, example_value? }>` — the parameter contract. Build your `params` object from these keys.
- `requires_third_party_terms_confirmation` — if true, you must pass `confirmThirdPartyTerms: true` on execute.

## Misses and `next_actions`

When there's no useful endpoint, `available_endpoints` is empty/absent and `next_actions` carries actionable handoffs:

```ts
const handoff = resolved.next_actions?.[0];
// { endpoint_id, operation_id, title, why, command }
console.log(handoff?.command); // e.g. "unbrowse browse go --url ..."
```

Typical `next_actions` shapes:

- A browse-session handoff (auth wall, JS-required pages) — the agent runs `browse go` / `snap` / `close`.
- A re-resolve with different params.
- An explicit "abandon or authenticate" instruction.

## Common parameters

```ts
await u.resolve({
  intent: "search jmail for receipts from stripe",
  url: "https://jmail.world",
  params: { q: "from:stripe" },
});
```

## Anti-patterns

- Looping `resolve` on the same host after an empty shortlist. Trust `next_actions[0].command`.
- Passing `forceCapture: true` to bypass a stale cache. Use `feedback({ outcome: "failure" })` instead so the cache learns.
- Setting `confirmThirdPartyTerms: true` blanket-style. It's a real legal gate.
