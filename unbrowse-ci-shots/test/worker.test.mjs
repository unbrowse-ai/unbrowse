// The pictures worker against a stand-in for its R2 bucket: only the key CI holds puts a picture, only a picture of
// the type its name says goes in, an address names one picture and nothing lists them, and a picture is read back as
// put, unsigned, as GitHub fetches a comment's image.
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const KEY = "k".repeat(64);
const RUN = "0123456789abcdef0123456789abcdef";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function bucket() {
  const kept = new Map();
  return {
    kept,
    async get(key) {
      const v = kept.get(key);
      return v ? { body: v.bytes } : null;
    },
    async put(key, bytes, opts) {
      kept.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType });
    },
  };
}

const at = (path, init) => new Request(`https://shots.example${path}`, init);
const put = (path, body, key = KEY, type = "image/png") =>
  at(path, { method: "PUT", body, headers: { authorization: `Bearer ${key}`, "content-type": type } });

test("CI's key puts a picture, and anyone can read it back", async () => {
  const env = { SHOTS: bucket(), SHOTS_KEY: KEY };
  const made = await worker.fetch(put(`/s/${RUN}/check-14.png`, PNG), env);
  assert.equal(made.status, 201);
  assert.equal((await made.json()).url, `https://shots.example/s/${RUN}/check-14.png`);
  const got = await worker.fetch(at(`/s/${RUN}/check-14.png`), env);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), PNG);
});

test("without the key, or with another, nothing is put", async () => {
  const env = { SHOTS: bucket(), SHOTS_KEY: KEY };
  assert.equal((await worker.fetch(put(`/s/${RUN}/a.png`, PNG, "wrong"), env)).status, 401);
  assert.equal((await worker.fetch(at(`/s/${RUN}/a.png`, { method: "PUT", body: PNG }), env)).status, 401);
  assert.equal((await worker.fetch(put(`/s/${RUN}/a.png`, PNG), { SHOTS: env.SHOTS })).status, 401, "a worker with no key set takes nothing");
  assert.equal(env.SHOTS.kept.size, 0);
});

test("only a picture of the type its name says goes in", async () => {
  const env = { SHOTS: bucket(), SHOTS_KEY: KEY };
  const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
  assert.equal((await worker.fetch(put(`/s/${RUN}/a.png`, html), env)).status, 415);
  assert.equal((await worker.fetch(put(`/s/${RUN}/a.jpg`, PNG), env)).status, 415, "a png named jpg");
  assert.equal((await worker.fetch(put(`/s/${RUN}/a.svg`, PNG), env)).status, 404, "no svg: it can carry script");
  assert.equal((await worker.fetch(put(`/s/${RUN}/a.png`, new Uint8Array(0)), env)).status, 413);
  assert.equal((await worker.fetch(put(`/s/${RUN}/a.png`, new Uint8Array(4 * 1024 * 1024 + 1).fill(0x89)), env)).status, 413);
  assert.equal(env.SHOTS.kept.size, 0);
});

test("an address names one picture: no listing, no other paths, no guessable run", async () => {
  const env = { SHOTS: bucket(), SHOTS_KEY: KEY };
  await worker.fetch(put(`/s/${RUN}/a.png`, PNG), env);
  for (const path of ["/", "/s/", `/s/${RUN}/`, `/s/${RUN}`, "/s/42/a.png", `/s/${RUN}/../a.png`, `/s/${RUN}/A.png`, `/s/${RUN}/sub/a.png`]) {
    assert.equal((await worker.fetch(at(path), env)).status, 404, path);
  }
  assert.equal((await worker.fetch(at(`/s/${RUN}/b.png`), env)).status, 404, "a picture never put");
  assert.equal((await worker.fetch(at(`/s/${RUN}/a.png`, { method: "DELETE" }), env)).status, 405);
});

test("a picture is served as a picture and nothing more", async () => {
  const env = { SHOTS: bucket(), SHOTS_KEY: KEY };
  await worker.fetch(put(`/s/${RUN}/a.png`, PNG), env);
  const got = await worker.fetch(at(`/s/${RUN}/a.png`), env);
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.equal(got.headers.get("content-security-policy"), "default-src 'none'");
  const head = await worker.fetch(at(`/s/${RUN}/a.png`, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});
