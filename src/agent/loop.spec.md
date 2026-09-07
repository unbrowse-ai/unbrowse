# Minimal Loop — Browser Use → Unbrowse

One-pager mapping Browser Use primitives (https://browser-use.com/blog/the-bitter-lesson-of-agent-frameworks) to unbrowse.

| Browser Use primitive | Unbrowse location | Notes |
|---|---|---|
| `for(;;){ ainvoke(messages, tools) }` | `src/agent/loop.ts:runLoop` | `while(true){ res=await model.ainvoke(visibleMessages,tools); ... }` — no planning/verification wrappers |
| `BaseChatModel.ainvoke(messages, tools)` Protocol | `ChatModel` interface + `ChatAnthropic`/`ChatOpenAI`/`ChatGoogle` | Identical surface per article; provider keys are ops |
| `done(message)` tool → `raise TaskComplete` | `Tool{name:'done'}` + `TaskComplete` error | `if (c.name==='done') throw TaskComplete(c.args.message)` — explicit termination, no string parsing |
| Ephemeral messages (keep last 3 browser states) | `ChatMessage.ephemeral` + `visibleMessages()` / `pruneEphemeralInPlace()` | 50KB × N → 1MB crash without pruning; non-ephemeral always kept |
| Retries + exponential backoff | Comment in `runLoop` | Ops (observability/middleware), not code — per article |
| Token tracking | Comment in `runLoop` + `ainvoke` stubs | Ops, counted outside loop |
| Maximal action space (entire SDK) then restrict | Tools array passed to `ainvoke` | Loop takes any `Tool[]`; restriction is deny-list via eval, not allow-list framework |
| Existing harness memory | `src/harness/memory.ts` (unchanged) | Last-run record stays durable; loop is stateless except `messages` |

**What was removed:** planning modules, verification layers, framework wrappers around the loop. The loop is 30 lines; leverage comes from the model, not the framework — 99% model, 1% code.

**Witness:** `bun test tests/agent-loop.test.ts` (3 tests: ephemeral keeps last 3, done terminates, plain tool loops). `bun test tests/agent-path.test.ts` stays green.
