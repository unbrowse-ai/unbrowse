# unbrowse

> Browser-parity agent automation with self-learning skills and a local marketplace.

unbrowse watches a browser session, reverse-engineers the API calls being made, packages them into a versioned **Skill**, and re-executes them on demand — no scraping, no brittle CSS selectors. Skills are stored locally, indexed in [EmergentDB](https://emergentdb.com) for semantic search, and reused automatically on future identical intents.

---

## How it works

```
intent + url
     │
     ▼
 EmergentDB search  ──(score ≥ 0.30)──▶  execute from marketplace  ──▶  result
     │
  (no match)
     │
     ▼
 agent-browser (Playwright)
  launches headless session
  navigates to url, records HAR
     │
     ▼
 reverse-engineer
  scores & deduplicates requests
  filters JS bundles, trackers
     │
     ▼
 AJV validation
     │
     ▼
 publish to marketplace
  writes skills/{id}.json
  indexes into EmergentDB (1536-dim Gemini embeddings)
     │
     ▼
 executeSkill  ──▶  result + ExecutionTrace
```

Second call for the same intent hits **marketplace** (no browser launch).

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| HTTP server | [Fastify v5](https://fastify.dev) |
| Browser | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) (Playwright) |
| Vector DB | [EmergentDB](https://emergentdb.com) |
| Embeddings | Gemini `gemini-embedding-001` — 1536 dims, normalized for inner product |
| Validation | AJV (hard errors block publish, soft warnings pass through) |
| Credential store | keytar (OS keychain) + AES-256-CBC file fallback |
| Lint / format | [Biome](https://biomejs.dev) |

---

## Quickstart

```bash
# 1. install
bun install

# 2. configure
cp .env.example .env
# fill in EMERGENTDB_API_KEY, GEMINI_API_KEY

# 3. run
bun dev
```

Server starts at `http://localhost:3000`.

---

## API

### Resolve an intent (auto-discover or reuse)

```http
POST /v1/intent/resolve
Content-Type: application/json

{
  "intent": "get trending searches",
  "context": { "url": "https://trends.google.com" }
}
```

Response:

```json
{
  "result": { ... },
  "source": "marketplace",
  "skill": { "skill_id": "...", "version": "1.0.0", ... },
  "trace": { "trace_id": "...", "success": true, ... }
}
```

`source` is `"marketplace"` when a cached skill matched, `"live-capture"` when the browser ran.

---

### Skills

```http
GET  /v1/skills                   # list all skills
GET  /v1/skills/:skill_id         # get one skill
POST /v1/skills                   # publish a skill manually
POST /v1/skills/:skill_id/execute # execute a skill directly
```

### Feedback

```http
POST /v1/feedback
```

```json
{
  "target_type": "skill",
  "target_id": "<skill_id>",
  "execution_trace_id": "<trace_id>",
  "outcome": "success",
  "rating": 5,
  "notes": "worked first try"
}
```

### Health

```http
GET /health  →  { "status": "ok" }
```

---

## Skill manifest

Skills are stored as JSON in `./skills/`. The schema:

```ts
interface SkillManifest {
  skill_id: string;          // nanoid
  version: string;           // semver, bumped on republish
  schema_version: string;
  name: string;
  intent_signature: string;  // natural-language intent used for embedding
  domain: string;            // e.g. "trends.google.com"
  subdomain?: string;
  description: string;
  owner_type: "agent" | "marketplace" | "user";
  endpoints: EndpointDescriptor[];
  lifecycle: "active" | "deprecated" | "disabled";
  created_at: string;
  updated_at: string;
  prev_version?: string;
}
```

Each endpoint carries its own auth plan (CSRF / OAuth), transform rules, reliability score, and idempotency hint.

---

## Project structure

```
src/
  api/           Fastify routes
  capture/       agent-browser wrapper (HAR recording, request tracking)
  discovery/     EmergentDB + Gemini embedding (index & search)
  execution/     hydrate auth, interpolate templates, call executeInBrowser
  marketplace/   local JSON skill store, semver versioning, dedup
  orchestrator/  main flow: search → execute or capture → publish → execute
  reverse-engineer/ score + filter HAR requests → EndpointDescriptors
  types/         shared TypeScript types
  validator/     AJV schema validation (hard errors vs soft warnings)
  vault/         keytar keychain + AES-256 file fallback
  index.ts       server entrypoint
skills/          published skill manifests (gitignored)
traces/          execution traces + feedback (gitignored)
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `EMERGENTDB_API_KEY` | yes | EmergentDB data plane key |
| `EMERGENTDB_NAMESPACE` | no | namespace for skill vectors (default: `unbrowse-skills`) |
| `GEMINI_API_KEY` | yes | Google AI Studio key for Gemini embeddings |
| `PORT` | no | HTTP port (default: `3000`) |
| `SKILLS_DIR` | no | path to skill store (default: `./skills`) |
| `TRACES_DIR` | no | path to trace store (default: `./traces`) |

---

## Scripts

```bash
bun dev        # watch mode
bun start      # production
bun run typecheck  # tsc --noEmit
bun run lint   # biome check
bun run format # biome format --write
```

---

## License

MIT
