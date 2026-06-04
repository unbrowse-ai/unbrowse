import { describe, expect, it } from "bun:test";
import * as srcKuri from "../src/kuri/client.js";
import * as skillKuri from "../packages/skill/runtime-src/kuri/client.js";

// Adversarial probe of resolveKuriLaunchConfig under malformed KURI_HEADLESS
// values. The contract is tri-state: explicitly truthy ("true"/"1") → headless,
// explicitly falsy ("false"/"0"/"no"/"off") → visible, anything else → safe
// default headless=true with a stderr warning. These cases lock that in so any
// future regression that lets a typo silently flood the screen is caught.

type Case = {
  label: string;
  env: NodeJS.ProcessEnv;
  expectedHeadless: boolean;
  note: string;
};

const cases: Case[] = [
  {
    label: 'KURI_HEADLESS="" (empty string) → safe default headless=true',
    env: { KURI_HEADLESS: "" },
    expectedHeadless: true,
    note: "tri-state: empty is unrecognized, falls back to safe default",
  },
  {
    label: 'KURI_HEADLESS="banana" → safe default headless=true',
    env: { KURI_HEADLESS: "banana" },
    expectedHeadless: true,
    note: "tri-state: garbage is unrecognized, falls back to safe default",
  },
  {
    label: 'KURI_HEADLESS="truex" → safe default headless=true (typo of true)',
    env: { KURI_HEADLESS: "truex" },
    expectedHeadless: true,
    note: "tri-state: typo is unrecognized, falls back to safe default",
  },
  {
    label: 'KURI_HEADLESS="  true  " → safe default headless=true (no trim)',
    env: { KURI_HEADLESS: "  true  " },
    expectedHeadless: true,
    note: "tri-state: untrimmed is unrecognized, falls back to safe default",
  },
  {
    label: 'KURI_HEADLESS="True" → headless (toLowerCase works)',
    env: { KURI_HEADLESS: "True" },
    expectedHeadless: true,
    note: "case-insensitive match via toLowerCase",
  },
  {
    label: 'KURI_HEADLESS="TRUE" → headless (toLowerCase works)',
    env: { KURI_HEADLESS: "TRUE" },
    expectedHeadless: true,
    note: "case-insensitive match via toLowerCase",
  },
  {
    label: 'KURI_HEADLESS="yes" → safe default headless=true',
    env: { KURI_HEADLESS: "yes" },
    expectedHeadless: true,
    note: "tri-state: yes/on/y are not recognized as truthy or falsy, fall back to safe default",
  },
  {
    label: 'KURI_HEADLESS="0" → visible (intentional opt-out)',
    env: { KURI_HEADLESS: "0" },
    expectedHeadless: false,
    note: "explicit opt-out, intended behavior",
  },
  {
    label: 'KURI_HEADLESS="false" → visible (intentional opt-out)',
    env: { KURI_HEADLESS: "false" },
    expectedHeadless: false,
    note: "explicit opt-out, intended behavior",
  },
  {
    label: "KURI_HEADLESS unset → headless (safe default)",
    env: {},
    expectedHeadless: true,
    note: "no env value, default-to-true path",
  },
];

describe("kuri headless adversarial env values", () => {
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
