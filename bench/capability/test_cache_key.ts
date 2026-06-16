// Witness (jesus-ralph): the cache key includes method + body (no POST/GraphQL collision) and only
// IDEMPOTENT requests are cacheable. Fixes the broken key where two POSTs with different bodies
// collided. Run: bun bench/capability/test_cache_key.ts
import { requestCacheKey, isIdempotentRequest } from "../../src/values/cache-key.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

// 1) THE BUG: two POSTs, same url+intent, DIFFERENT body → DIFFERENT keys (no collision).
const kA = requestCacheKey({ intent: "gql", url: "https://api/graphql", method: "POST", body: '{"query":"{ a }"}' });
const kB = requestCacheKey({ intent: "gql", url: "https://api/graphql", method: "POST", body: '{"query":"{ b }"}' });
ok(kA !== kB, "two POSTs with different bodies → DIFFERENT cache keys (collision fixed)");
ok(requestCacheKey({ intent: "gql", url: "https://api/graphql", method: "POST", body: '{"query":"{ a }"}' }) === kA,
   "same (method,url,body,intent) → same key (deterministic hit)");
// method matters too: a GET and a POST to the same url+intent must differ.
ok(requestCacheKey({ intent: "x", url: "u" }) !== requestCacheKey({ intent: "x", url: "u", method: "POST", body: "b" }),
   "GET vs POST → different keys (method folded in)");
// back-compat: a plain GET key still carries intent+url+params.
ok(/intent-resolve/.test(requestCacheKey({ intent: "x", url: "u" })), "GET key shape preserved (intent-resolve …)");

// 2) IDEMPOTENCY GATE — what may be cached + replayed.
ok(isIdempotentRequest("GET"), "GET is idempotent (cacheable)");
ok(isIdempotentRequest("HEAD"), "HEAD is idempotent");
ok(isIdempotentRequest(undefined), "no method → defaults GET → cacheable");
ok(isIdempotentRequest("POST", '{"query":"query Repos { viewer { login } }"}'), "POST GraphQL QUERY → idempotent read (cacheable — KV speedup)");
ok(isIdempotentRequest("POST", '{"query":"{ viewer { login } }"}'), "POST GraphQL shorthand query → cacheable");
// writes must NOT be cached.
ok(!isIdempotentRequest("POST", '{"query":"mutation { addStar }"}'), "POST GraphQL MUTATION → NOT cacheable");
ok(!isIdempotentRequest("POST", '{"query":"subscription { onX }"}'), "GraphQL subscription → NOT cacheable");
ok(!isIdempotentRequest("POST", '{"id":"123","amount":50}'), "generic POST (non-GraphQL write) → NOT cacheable");
ok(!isIdempotentRequest("PUT", "{}"), "PUT → NOT cacheable (write)");
ok(!isIdempotentRequest("DELETE"), "DELETE → NOT cacheable (write)");
ok(!isIdempotentRequest("PATCH", "{}"), "PATCH → NOT cacheable (write)");

console.log(fails === 0 ? "\nCACHE-KEY WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
