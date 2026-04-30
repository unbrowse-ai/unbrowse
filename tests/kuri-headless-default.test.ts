import { describe, expect, it } from "bun:test";
import * as srcKuri from "../src/kuri/client.js";
import * as skillKuri from "../packages/skill/runtime-src/kuri/client.js";

// Locks the kuri-headless-default flip in place. Production unbrowse must never
// pop a visible Chrome onto the user's screen. Both client copies (src/ and
// packages/skill/runtime-src/) must agree — the parity assertions break if a
// future edit lands in only one mirror.

const cases: Array<{
  label: string;
  env: NodeJS.ProcessEnv;
  expectedHeadless: boolean;
}> = [
  { label: "clean env defaults to headless", env: {}, expectedHeadless: true },
  { label: "KURI_HEADLESS=false opts out", env: { KURI_HEADLESS: "false" }, expectedHeadless: false },
  { label: "HEADLESS=0 opts out", env: { HEADLESS: "0" }, expectedHeadless: false },
  { label: "KURI_HEADLESS=true stays headless", env: { KURI_HEADLESS: "true" }, expectedHeadless: true },
];

describe("kuri headless default", () => {
  for (const { label, env, expectedHeadless } of cases) {
    it(`src: ${label}`, () => {
      expect(srcKuri.resolveKuriLaunchConfig(env).headless).toBe(expectedHeadless);
    });
    it(`skill mirror: ${label}`, () => {
      expect(skillKuri.resolveKuriLaunchConfig(env).headless).toBe(expectedHeadless);
    });
    it(`mirror parity: ${label}`, () => {
      const fromSrc = srcKuri.resolveKuriLaunchConfig(env).headless;
      const fromSkill = skillKuri.resolveKuriLaunchConfig(env).headless;
      expect(fromSrc).toBe(fromSkill);
    });
  }
});
