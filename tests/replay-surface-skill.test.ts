/**
 * GATE: the SKILL surface can replay a learned route natively.
 *
 * The "skill" surface is `packages/skill` — an npm package whose agent-facing
 * contract is SKILL.md (instructions) plus the `unbrowse` CLI (the runtime the
 * instructions drive). So a gate for this surface has to bind BOTH halves:
 * the command SKILL.md tells an agent to run, and what that command actually
 * does. Either half drifting is a regression.
 *
 * WHAT THIS GATE PROVES
 *   1. packages/skill/SKILL.md still documents the one-hole front door
 *      `unbrowse "<what you want>" --url "<site>"` as the default path.
 *   2. Running that exact command against a page URL, with a learned route in
 *      the local stores, causes a DIRECT HTTP GET to the learned route's own
 *      URL — a path the caller never supplied — and returns its bytes.
 *   3. It does so with the marketplace and live browser capture BOTH disabled,
 *      so the learned route is the only possible source of the payload.
 *
 * WHAT THIS GATE DOES NOT PROVE
 *   - It does not exercise the packaged `bin/unbrowse-wrapper.mjs` ->
 *     `runtime/cli.js` launch chain; it runs the CLI from source
 *     (`bun src/cli.ts`), which is the same code the runtime bundle is built
 *     from but not the same artifact.
 *   - It does not cover the OTHER path SKILL.md documents,
 *     `unbrowse resolve --no-execute` then `unbrowse execute --skill ID
 *     --endpoint ID`. That path does not work today (see the accompanying
 *     report); a gate asserting it would be permanently red, and a gate that
 *     quietly skipped it would certify the wrong thing.
 *   - It does not prove anything about authenticated replay. The fixture route
 *     is unauthenticated by design (no real credential is used anywhere here).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_MARKER,
  LEARNED_PATH,
  REPO_ROOT,
  hermeticEnv,
  makeHermeticHome,
  runSurface,
  seedLearnedRoute,
  startFixtureOrigin,
  type FixtureOrigin,
} from "./_learned-route-fixture.js";

const INTENT = "list the fixture items";

let fixture: FixtureOrigin | null = null;
afterEach(() => {
  fixture?.stop();
  fixture = null;
});

describe("skill surface replays a learned route", () => {
  test("SKILL.md still documents the one-hole front door", () => {
    const skillMd = readFileSync(join(REPO_ROOT, "packages/skill/SKILL.md"), "utf8");
    // Boolean, not toContain: a failed toContain would dump the whole 20KB file.
    expect(
      skillMd.includes('unbrowse "<what you want>" --url "<site>"'),
      'packages/skill/SKILL.md must document `unbrowse "<what you want>" --url "<site>"` — ' +
        "it is the only documented replay path this gate can prove works.",
    ).toBe(true);
  });

  test(
    '`unbrowse "<intent>" --url <page>` replays the learned route as a direct API call',
    async () => {
      const home = makeHermeticHome("skill");
      fixture = startFixtureOrigin();
      seedLearnedRoute(home, fixture.origin, { skillId: "skillgatefixture", intent: INTENT });

      const run = await runSurface(
        ["bun", "src/cli.ts", INTENT, "--url", `${fixture.origin}/`, "--json"],
        hermeticEnv(home),
      );

      const diag =
        `exit=${run.code}\n--- stdout ---\n${run.stdout.slice(0, 4000)}\n` +
        `--- stderr ---\n${run.stderr.slice(-3000)}\n--- origin saw ---\n${JSON.stringify(fixture.seen)}`;

      // 1. The learned route — a URL the caller never supplied — was actually
      //    requested over HTTP by the surface.
      expect(fixture.replayed(), `origin never saw GET ${LEARNED_PATH}\n${diag}`).toBe(true);

      // 2. The learned route's bytes came back to the caller.
      expect(run.stdout, `payload marker missing from CLI output\n${diag}`).toContain(FIXTURE_MARKER);

      // 3. The call succeeded and named the learned route it replayed.
      expect(run.code, `CLI exited non-zero\n${diag}`).toBe(0);
      expect(run.stdout, `trace did not name the learned endpoint\n${diag}`).toContain("list_items");

      // 4. No browser. A capture/browse escalation would show up as a session
      //    open on the fixture origin's HTML page beyond the single context
      //    probe, and the runtime would log the browse ladder.
      expect(run.stderr, `browse ladder was entered — this is not a native replay\n${diag}`)
        .not.toMatch(/browse session|handing off to browser ladder|live-capture/i);
    },
    180_000,
  );
});
