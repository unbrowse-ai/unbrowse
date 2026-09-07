# Pointer, not payload

## The rule

Every value the runtime needs is reachable via an opaque pointer. Never inlined as a payload field that lives only in process memory.

A URL is a pointer. A skill identifier is a pointer. A capability name is a pointer. A row id in the append-only trace store is a pointer. A capture id in the marketplace is a pointer.

A 50KB JSON blob copied into three call sites is a payload. We do not write code like that.

## Why it exists

Three things become possible when every value is a pointer:

1. **Dependency-capture completeness.** Every binding a browser needs (cookies, auth headers, CSRF, runtime config, SSR or JS-heap bindings, the full request closure) is traversed during capture. The captures share their bindings by reference, not by copy.

2. **Stateless trace.** The append-only trace log is the sole source of truth. Recomputing any value requires no in-memory session state. Any process can read the trace and reproduce the value.

3. **Recomputable DAG.** The graph that powers route resolution is a pure function of the captured endpoints. Same inputs, same graph, any time, any process.

## What this looks like in the code

| Surface | The pointer | Where the payload lives |
|---|---|---|
| Browser capture | URL of the captured request | Real disk, append-only trace store |
| Skill resolution | skill_id (8-character hex) | Backend marketplace, never inline |
| Auth | vault key id | Local keychain or vault file, never in trace |
| Cookie injection | domain string | Real Chrome/Firefox SQLite, never copied |
| Endpoint dependency | requires/yields binding keys | Trace store; the graph reads them |

The local client holds opaque pointers. The compute layer (capture, ranking, resolution) reads them on demand. This is also the rule for the local-versus-cloud split: the local CLI holds capability pointers (browser binary path, cookie store location, vault key id, kuri binary path). The cloud holds the actual compute and the ledger.

## What the rule rules out

- Copying a JSON blob into a request body when a URL would have referenced it.
- Storing a derived value in process memory instead of recomputing from the pointer when needed.
- Sending a payload across the local-cloud boundary when a pointer reference would suffice.
- Passing a capability by value (the binary, the keypair, the cookie jar) when a pointer to it (the path, the key id, the domain) would do.

## How it stays in force

The architectural review on every shipping-surface PR includes the question: does any new field carry a value that could have been a pointer? If yes, the field is rewritten.

The trace store schema is append-only and content-addressed. A drift from pointer to payload would change the row shape, which the schema rejects at write time.
