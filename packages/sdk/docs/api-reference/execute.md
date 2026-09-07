# `execute` and `getSkill`

Replay a skill captured earlier (by id, or via the resolve response object).

```ts
u.execute(skill: string | ExecuteInput | ResolveResponse, input?, options?): Promise<ExecuteResponse>
u.getSkill(skillId: string, options?): Promise<SkillManifest>
```

## Three call styles

```ts
// 1. Pass a resolve response: uses its top pick.
const resolved = await u.resolve({ intent, url });
await u.execute(resolved, { projection: { raw: true } });

// 2. Pass a skill id directly.
await u.execute("skill_abc123", { params: { symbol: "NVDA" } });

// 3. Pass an endpoint id from the shortlist.
const pick = resolved.available_endpoints?.[0];
if (pick) {
  await u.execute(pick.endpoint_id, {
    params: { q: "rust" },
    projection: { raw: false },
    intent: "search crates for rust",
  });
}
```

## Input

```ts
interface ExecuteInput {
  skillId: string;
  params?: Record<string, unknown>;
  projection?: ProjectionOptions;
  confirmUnsafe?: boolean;
  confirmThirdPartyTerms?: boolean;
  dryRun?: boolean;
  intent?: string;
  contextUrl?: string;
}
```

## Output

From `packages/sdk/src/contracts.ts`:

```ts
interface ExecuteResponse {
  result: unknown;                  // the actual data the endpoint returned
  trace: ExecutionTrace;            // success / status_code / error / tokens_used live here
  skill?: SkillManifest;
  timing?: OrchestrationTiming;
  source?: string;
  impact?: AgentImpact;
  next_actions?: AgentNextAction[];
  [key: string]: unknown;
}

interface ExecutionTrace {
  success: boolean;
  status_code?: number;
  error?: string;
  result?: unknown;
  // ... ids, timestamps, tokens
}
```

Check success via the trace, not via a top-level boolean:

```ts
const r = await u.execute(pick.endpoint_id, { params });
if (r.trace.success) {
  console.log(r.result);          // the data
} else {
  console.error(r.trace.error, r.trace.status_code);
}
```

## Raw vs. extracted

Default: auto-extract fires only on response bodies > 64 KB. Smaller bodies are returned untouched. Set `projection: { raw: true }` to force the raw body for any size.

## `contextUrl` is important

When the user is on `https://reddit.com/r/singularity` and you replay a captured `r/<sub>/posts.json` skill, pass `contextUrl: "https://reddit.com/r/singularity"`. The runtime substitutes the entity from the URL into the template (A8). Without it, the executed URL might match a different subreddit captured originally.

## `getSkill`

Fetch the manifest for a skill id without executing:

```ts
const manifest = await u.getSkill("skill_abc123");
console.log(manifest.endpoints.map(e => e.url));
```

Useful for inspecting what an LLM is about to call.
