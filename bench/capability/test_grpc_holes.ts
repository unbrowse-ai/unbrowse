// Witness: Connect/gRPC hole decomposition mirrors GraphQL — request-message fields
// become flat agent-fillable holes; service/method path stays fixed structure; the
// agent's value overrides the example; placeholders are dropped. Run: bun bench/capability/test_grpc_holes.ts
import { decomposeGrpcEndpoint, buildGrpcRequestBody } from "../../src/execution/index.ts";

let fails = 0;
function ok(cond: boolean, msg: string) { if (!cond) { console.error("  FAIL", msg); fails++; } else console.log("  ok  ", msg); }

const grpcEndpoint: any = {
  endpoint_id: "grpc-unary",
  url_template: "https://api.example.com/tweet.v1.TweetService/GetTweet",
  semantic: { example_request: { tweetId: "{tweetId}", count: 20, includeRetweets: true, lang: "en" } },
};

const d = decomposeGrpcEndpoint(grpcEndpoint);
ok(d.isGrpc === true, "detects Connect/gRPC unary path");
ok(d.service === "tweet.v1.TweetService", `service parsed (got ${d.service})`);
ok(d.method === "GetTweet", `method parsed (got ${d.method})`);
const keys = d.agentParams.map((p) => p.key).sort();
ok(JSON.stringify(keys) === JSON.stringify(["count", "includeRetweets", "lang", "tweetId"]),
   `all scalar message fields are holes incl. the placeholder (got ${JSON.stringify(keys)})`);
const tweetHole = d.agentParams.find((p) => p.key === "tweetId");
ok(tweetHole?.required === true && tweetHole?.example === null,
   "named placeholder {tweetId} surfaced as a REQUIRED hole (example null)");
ok(d.agentParams.find((p) => p.key === "count")?.required === false,
   "captured-value field is an OPTIONAL hole (its value is the example)");
ok(d.agentParams.every((p) => p.message_path === p.key), "each hole carries its message_path");

// Agent fills the real value; example + structure preserved; placeholder gone.
const body = buildGrpcRequestBody(d, { tweetId: "1899999999", count: 50 });
const msg = JSON.parse(body);
ok(msg.tweetId === "1899999999", `agent value bound into message (tweetId=${msg.tweetId})`);
ok(msg.count === 50, `agent override wins over example (count=${msg.count})`);
ok(msg.includeRetweets === true && msg.lang === "en", "untouched example fields preserved");
ok(!/\{tweetId\}/.test(body), "placeholder pseudo-value never leaks into the body");

// A non-gRPC REST endpoint must NOT be misdetected.
const rest: any = { url_template: "https://api.github.com/repos/torvalds/linux", semantic: {} };
ok(decomposeGrpcEndpoint(rest).isGrpc === false, "REST path is not misclassified as gRPC");

console.log(fails === 0 ? "\nALL gRPC-HOLE WITNESSES PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
