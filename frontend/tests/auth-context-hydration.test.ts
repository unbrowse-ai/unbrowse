// No-mock regression test for the auth-context hydration race.
//
// Pre-fix: useState initialized to all-null and a useEffect later read
// localStorage on mount. Every consumer that gated UX on `isAuthenticated`
// rendered the "logged out" view for one render tick after every
// navigation. The user perceived this as their login being purged.
//
// Post-fix: useState uses a lazy initializer that reads localStorage on
// the very first client render. A separate `hydrated` flag lets consumers
// distinguish the SSR/initial-render window (where localStorage is not
// yet readable) from "actually logged out".
//
// These tests are structural pins that read the source itself, so a
// future refactor that re-introduces the bug fails the pin instead of
// silently regressing on real users.
//
// Run: cd frontend && bun test tests/auth-context-hydration.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const AUTH_PATH = resolve(import.meta.dir, "..", "src", "lib", "auth-context.tsx");
const SRC = readFileSync(AUTH_PATH, "utf8");

describe("auth-context hydration race fix", () => {
  test("AuthContextValue exposes hydrated:boolean (consumers can render loading state)", () => {
    expect(SRC).toContain("hydrated: boolean;");
  });

  test("useState uses a lazy initializer (readStoredAuth as function reference)", () => {
    // The lazy form is `useState<AuthState>(readStoredAuth)` (function
    // reference, no parentheses). The eager form `useState({...nulls})`
    // is what caused the original bug.
    expect(SRC).toContain("useState<AuthState>(readStoredAuth)");
  });

  test("readStoredAuth returns EMPTY_AUTH on SSR (typeof window === 'undefined')", () => {
    expect(SRC).toContain("typeof window === \"undefined\"");
    expect(SRC).toContain("function readStoredAuth(): AuthState");
  });

  test("hydrated starts false and is set true in useEffect", () => {
    expect(SRC).toContain("const [hydrated, setHydrated] = useState<boolean>(false);");
    expect(SRC).toContain("setHydrated(true);");
  });

  test("provider value includes hydrated alongside state", () => {
    // Spread state first, then hydrated, so an accidental `...state`
    // ordering that overwrites hydrated cannot land.
    const valueMatch = SRC.match(/value=\{\{\s*\.\.\.state,\s*hydrated,/);
    expect(valueMatch).not.toBeNull();
  });

  test("readStoredAuth guards against partial or malformed JSON", () => {
    // The stored shape pre-fix was trusted with `setState(JSON.parse(stored))`,
    // which would set `apiKey: undefined` if the stored blob was a stale
    // schema. The fix validates the parsed object has a string apiKey.
    expect(SRC).toContain('typeof parsed.apiKey !== "string"');
  });
});
