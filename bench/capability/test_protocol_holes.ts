// Witness: JSON-RPC 2.0 + form-data/urlencoded hole decomposition mirror GraphQL/gRPC.
// JSON-RPC: method=fixed structure, params fields=holes. Form: body fields=holes, encoding from
// content-type. Run: bun bench/capability/test_protocol_holes.ts
import {
  decomposeJsonRpcEndpoint, buildJsonRpcRequestBody,
  decomposeFormEndpoint, buildFormRequestBody,
  decomposeXmlEndpoint, buildXmlRequestBody,
} from "../../src/execution/index.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

// ── JSON-RPC 2.0 (named params) ──────────────────────────────────────────────
const rpcEp: any = {
  url_template: "https://mainnet.example.org/rpc",
  semantic: { example_request: { jsonrpc: "2.0", method: "eth_getBalance", params: { address: "{address}", block: "latest" }, id: 1 } },
};
const r = decomposeJsonRpcEndpoint(rpcEp);
ok(r.isJsonRpc === true, "detects JSON-RPC 2.0 body");
ok(r.method === "eth_getBalance", `method = fixed structure (got ${r.method})`);
const rkeys = r.agentParams.map((p) => p.key).sort();
ok(JSON.stringify(rkeys) === JSON.stringify(["address", "block"]), `params fields are holes (got ${JSON.stringify(rkeys)})`);
ok(r.agentParams.find((p) => p.key === "address")?.required === true, "placeholder {address} = required hole");
ok(r.agentParams.find((p) => p.key === "block")?.required === false, "captured 'latest' = optional hole");
const rpcBody: any = buildJsonRpcRequestBody(r, { address: "0xABC123" });
ok(rpcBody.jsonrpc === "2.0" && rpcBody.method === "eth_getBalance", "rebuilt body keeps jsonrpc+method");
ok(rpcBody.params.address === "0xABC123" && rpcBody.params.block === "latest", "agent value bound, example preserved");
ok(rpcBody.id === 1, "id preserved");
ok(!JSON.stringify(rpcBody).includes("{address}"), "placeholder never leaks");

// ── JSON-RPC positional params ───────────────────────────────────────────────
const rpcPos: any = { semantic: { example_request: { jsonrpc: "2.0", method: "getBlockByNumber", params: ["{blockNum}", true] } } };
const rp = decomposeJsonRpcEndpoint(rpcPos);
ok(rp.positional === true && rp.agentParams.some((p) => p.key === "params[0]"), "positional params surfaced by index");
const rpBody: any = buildJsonRpcRequestBody(rp, { "params[0]": "0x10" });
ok(rpBody.params[0] === "0x10" && rpBody.params[1] === true, "positional agent value bound, rest preserved");

// ── form-data / urlencoded ───────────────────────────────────────────────────
const formEp: any = {
  headers_template: { "content-type": "application/x-www-form-urlencoded" },
  semantic: { example_request: { username: "{username}", remember: "true", csrf: "abc" } },
};
const f = decomposeFormEndpoint(formEp);
ok(f.isForm === true && f.encoding === "urlencoded", "detects urlencoded form");
const fkeys = f.agentParams.map((p) => p.key).sort();
ok(JSON.stringify(fkeys) === JSON.stringify(["csrf", "remember", "username"]), `form fields are holes (got ${JSON.stringify(fkeys)})`);
ok(f.agentParams.find((p) => p.key === "username")?.required === true, "placeholder {username} = required hole");
const fBody: any = buildFormRequestBody(f, { username: "neo" }, formEp.semantic.example_request);
ok(fBody.username === "neo" && fBody.remember === "true" && fBody.csrf === "abc", "agent value bound, other fields preserved");
ok(!JSON.stringify(fBody).includes("{username}"), "placeholder never leaks into form body");

// multipart detection
const mp = decomposeFormEndpoint({ headers_template: { "Content-Type": "multipart/form-data; boundary=x" }, semantic: { example_request: { file: "a" } } } as any);
ok(mp.isForm === true && mp.encoding === "multipart", "detects multipart form");

// negatives: a plain JSON REST body is neither JSON-RPC nor form
const plain: any = { headers_template: { "content-type": "application/json" }, semantic: { example_request: { q: "x" } } };
ok(decomposeJsonRpcEndpoint(plain).isJsonRpc === false, "plain JSON not misdetected as JSON-RPC");
ok(decomposeFormEndpoint(plain).isForm === false, "plain JSON not misdetected as form");

// ── SOAP / XML ───────────────────────────────────────────────────────────────
const soapEp: any = {
  headers_template: { "content-type": "application/soap+xml; charset=utf-8" },
  semantic: { example_request:
    `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><GetWeather><City>{City}</City><Country>US</Country></GetWeather></soap:Body></soap:Envelope>` },
};
const x = decomposeXmlEndpoint(soapEp);
ok(x.isXml === true && x.flavor === "soap", "detects SOAP envelope");
const xkeys = x.agentParams.map((p) => p.key).sort();
ok(JSON.stringify(xkeys) === JSON.stringify(["City", "Country"]), `leaf elements are holes (got ${JSON.stringify(xkeys)})`);
ok(x.agentParams.find((p) => p.key === "City")?.required === true, "placeholder <City>{City}</City> = required hole");
ok(x.agentParams.find((p) => p.key === "Country")?.required === false, "captured <Country>US</Country> = optional hole");
const xBody = buildXmlRequestBody(x, { City: "London" });
ok(/<City>London<\/City>/.test(xBody), "agent value substituted into leaf element");
ok(/<Country>US<\/Country>/.test(xBody), "untouched leaf preserved");
ok(!/\{City\}/.test(xBody), "placeholder never leaks into XML body");
ok(/<soap:Envelope/.test(xBody) && /<soap:Body>/.test(xBody), "envelope structure preserved");

// plain-XML (content-type only) + non-XML negative
const plainXml = decomposeXmlEndpoint({ headers_template: { "content-type": "text/xml" }, semantic: { example_request: "<req><id>{id}</id></req>" } } as any);
ok(plainXml.isXml === true && plainXml.flavor === "xml" && plainXml.agentParams[0]?.key === "id", "plain text/xml detected, id hole");
ok(decomposeXmlEndpoint({ headers_template: { "content-type": "application/json" }, semantic: { example_request: { q: "x" } } } as any).isXml === false, "JSON body not misdetected as XML");

console.log(fails === 0 ? "\nALL PROTOCOL-HOLE WITNESSES PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
