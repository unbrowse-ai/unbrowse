import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { publishEdgesToBackend } from "../src/orchestrator/dag-feedback.js";

test("standalone graph publication is disabled in favor of permit-bound manifests", () => {
  expect(() => publishEdgesToBackend("private.example", { operations: [], edges: [] }))
    .toThrow("graph_publish_requires_manifest_permit");
  const clientSource = readFileSync(path.join(import.meta.dir, "../src/client/index.ts"), "utf8");
  expect(clientSource).toContain('throw new Error("graph_publish_requires_manifest_permit")');
  expect(clientSource).not.toContain('api("POST", "/v1/graph/edges"');
});
