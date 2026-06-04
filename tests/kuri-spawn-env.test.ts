import { describe, expect, it } from "bun:test";
import * as srcKuri from "../src/kuri/client.js";
import * as skillKuri from "../packages/skill/runtime-src/kuri/client.js";

// Step 5 of the restricted Loop — proves the env passed to the kuri broker spawn
// (src/kuri/client.ts ~L732-737) propagates HEADLESS correctly under the rules
// of resolveKuriLaunchConfig. The spawn env construction is INLINE (not an
// exported helper), so this test reconstructs the same expression
// (`headless ? "true" : "false"`) and round-trips it. That is parity-by-
// duplication — flagged here so a future drift in the inline expression
// (e.g. switching to "1"/"0", or reading from a different field) won't be
// caught by this test alone. Pair with kuri-headless-default.test.ts.
//
// No Chrome is launched. Pure config + string round-trip.

type Resolver = (env: NodeJS.ProcessEnv) => { headless: boolean };

function buildSpawnEnv(resolver: Resolver, env: NodeJS.ProcessEnv): Record<string, string> {
  const launchConfig = resolver(env);
  // Mirror of src/kuri/client.ts L732-737 — the inline env passed to spawn().
  return {
    PORT: "0",
    HOST: "127.0.0.1",
    HEADLESS: launchConfig.headless ? "true" : "false",
  };
}

const cases: Array<{
  label: string;
  env: NodeJS.ProcessEnv;
  expectedSpawnHeadless: "true" | "false";
}> = [
  {
    label: "clean env -> spawn HEADLESS=true",
    env: {},
    expectedSpawnHeadless: "true",
  },
  {
    label: "HEADLESS=false -> spawn HEADLESS=false",
    env: { HEADLESS: "false" },
    expectedSpawnHeadless: "false",
  },
  {
    label: "KURI_HEADLESS=true overrides HEADLESS=false (?? precedence)",
    env: { KURI_HEADLESS: "true", HEADLESS: "false" },
    expectedSpawnHeadless: "true",
  },
  {
    label: "HEADLESS=0 -> spawn HEADLESS=false (envFlag treats 0 as falsey)",
    env: { HEADLESS: "0" },
    expectedSpawnHeadless: "false",
  },
];

describe("kuri spawn env propagates HEADLESS from resolveKuriLaunchConfig", () => {
  for (const { label, env, expectedSpawnHeadless } of cases) {
    it(`src: ${label}`, () => {
      const spawnEnv = buildSpawnEnv(srcKuri.resolveKuriLaunchConfig, env);
      expect(spawnEnv.HEADLESS).toBe(expectedSpawnHeadless);
    });
    it(`skill mirror: ${label}`, () => {
      const spawnEnv = buildSpawnEnv(skillKuri.resolveKuriLaunchConfig, env);
      expect(spawnEnv.HEADLESS).toBe(expectedSpawnHeadless);
    });
    it(`mirror parity: ${label}`, () => {
      const fromSrc = buildSpawnEnv(srcKuri.resolveKuriLaunchConfig, env).HEADLESS;
      const fromSkill = buildSpawnEnv(skillKuri.resolveKuriLaunchConfig, env).HEADLESS;
      expect(fromSrc).toBe(fromSkill);
    });
  }
});
