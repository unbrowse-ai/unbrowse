#!/usr/bin/env bun

import { runHarnessCli } from "./codex-harness.js";

await runHarnessCli().catch((error) => {
  console.error("[codex-harness] fatal", error);
  process.exit(1);
});
