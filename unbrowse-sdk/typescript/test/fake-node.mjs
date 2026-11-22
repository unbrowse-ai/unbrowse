// A fake node for the tests that need one answer of their own: it proves itself for `tokens` and signs what it answers,
// as the node does, and hands every other request to `handler(req, res, body)`. Not a test file.
import http from "node:http";
import { proofAnswer } from "./proof-fixture.mjs";
import { signing } from "./signed-fixture.mjs";

/** Starts it on a free port. `owner` is the owner token it holds, if any. Close it with `close()`. */
export async function fakeNode({ tokens, owner, handler }) {
  const seen = [];
  const server = http.createServer(signing((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const proof = proofAnswer(req.url, server.address().port, { agents: tokens, owner });
      if (proof) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(proof));
      }
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  }, () => [...tokens, ...(owner ? [owner] : [])]));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

export const json = (res, status, body, raw) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(raw ?? JSON.stringify(body));
};
