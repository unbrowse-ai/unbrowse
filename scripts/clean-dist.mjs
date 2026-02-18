import fs from "node:fs";
import path from "node:path";

// Avoid stale build artifacts getting packed into the OpenClaw plugin tarball.
const roots = [
  "packages/core/dist",
  "packages/agent-browser/dist",
  "packages/plugin/dist",
  "packages/core/.tsbuildinfo",
  "packages/agent-browser/.tsbuildinfo",
  "packages/plugin/.tsbuildinfo",
  ".tsbuildinfo",
];

for (const rel of roots) {
  const abs = path.resolve(process.cwd(), rel);
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
