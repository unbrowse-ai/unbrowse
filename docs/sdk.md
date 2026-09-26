# Client

`src/client.ts` is the `Unbrowse` client from the hosted service's own codebase. The CLI is built
on it. It wraps the REST API ([api.md](api.md)).

```ts
import { Unbrowse } from "unbrowse";

const ub = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY, baseUrl: "https://v3.unbrowse.ai/api/v1" });

let run = await ub.run({ task: "top stories on Hacker News", idempotencyKey: crypto.randomUUID() });
while (run.status === "accepted" || run.status === "working") {
  await new Promise((r) => setTimeout(r, 1000));
  run = await ub.inspect(run.runId);
}

if (run.status === "input_required") {
  const req = run.requirements.find((r) => r.state === "open")!;
  await ub.resume(run.runId, run.stateRevision, [
    { requirementId: req.id, expectedRevision: req.revision, action: "accept", values: { [req.affectedAction]: "CDG" } },
  ]);
}
```

| Method | Route |
|---|---|
| `run(request)` | `POST /runs` |
| `inspect(runId)` | `GET /runs/:id` |
| `resume(runId, expectedStateRevision, responses)` | `POST /runs/:id/responses` |
| `cancel(runId)` | `POST /runs/:id/cancel` |
| `discover(query)` | `POST /capabilities/search` |
| `usage()`, `me()` | `GET /usage`, `GET /me` |
| `learn({ har, traces, goal, title })`, `learned(id?)` | `POST /learn`, `GET /learned[/:id]` |
| `logins.list()`, `.save(login)`, `.remove({ origin } \| { ref })` | `/logins` |
| `sites(query?)`, `site(host)` | `GET /sites`, `GET /sites/:host` (no account) |
| `siteMcpUrl(host)` | `/sites/:host/mcp` |

Errors throw with `message`, `status` and the server's `body`. Types (`RunView`, `Requirement`,
`RunRequest`, …) are exported from `types.ts`.
