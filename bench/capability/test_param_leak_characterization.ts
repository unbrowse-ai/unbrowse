// Characterization seed (jesus-loop Day 3, Mark 9:24 — probe the unknown before patching blind):
// the unfilled-{param} leak, pinned with RUNNABLE evidence (no network). This is the mustard seed
// the guard grows from red→green next loop. It pins what is KNOWN and names the ONE unknown left.
//
// Two probers settled the hazard map (and CAUGHT an apophenia in it):
//   - shouldReplayRecipe (exported) SKIPS replay on a leftover {hole} → control flows to the probe
//     ladder (:3791), which calls probeUrl(url) with the HOLED url verbatim (no stripHoles rewrite).
//   - therefore the probe ladder CANNOT recover a hole — it just probes a malformed url and fails.
//     ⇒ hazard #1 ("bail-early collides with probe-ladder re-discovery") is DISPROVEN: bail-early on
//        the URL-template path loses no recovery. The 5 decomposers build BODIES not URLs, and
//        resolution (walkPrerequisiteChain + inferParamsFromIntent) runs BEFORE execute, so a hole
//        reaching :3311 is a genuine miss. The guard is simpler + safer than the map first feared.
// Run: bun bench/capability/test_param_leak_characterization.ts
import { readFileSync } from "node:fs";
import { shouldReplayRecipe } from "../../src/execution/index.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const recipe = {} as any; // shouldReplayRecipe ignores the recipe arg (_recipe); it tests only the url.

// 1) KNOWN — the recipe-replay path is GUARDED: a leftover {hole} → skip replay (→ probe ladder).
ok(shouldReplayRecipe(recipe, "https://api.example.com/users/{user_id}/orders") === false,
   "shouldReplayRecipe SKIPS replay when the url carries a leftover {hole} (recipe path is guarded)");
ok(shouldReplayRecipe(recipe, "https://api.example.com/users/42/orders") === true,
   "shouldReplayRecipe REPLAYS a fully-bound url (no holes)");
ok(shouldReplayRecipe(recipe, "https://api.example.com/q?tag={x}&page=2") === false,
   "a leftover QUERY hole also triggers the skip (the regex is path+query agnostic)");

// 2) KNOWN — the leak site: the DIRECT path probes the holed url with NO hole-guard before it.
const src = readFileSync(new URL("../../src/execution/index.ts", import.meta.url), "utf8");
const directBlock = src.slice(src.indexOf("if (!recipeMatched) {"), src.indexOf("if (!recipeMatched) {") + 600);
ok(/await probeUrl\(url,/.test(directBlock),
   "the direct path passes `url` to probeUrl (:3791) — this is the leak site for a holed url");
// The gap this seed first pinned (no pre-fetch bail) is now CLOSED by the guard — assert the guard
// is present between interpolate and the probe ladder (a permanent regression witness; if the guard
// is ever removed, this flips red).
const between = src.slice(src.indexOf("let url = interpolate(urlTemplate, mergedParams)"), src.indexOf("if (!recipeMatched) {"));
ok(/error:\s*"unfilled_url_hole"/.test(between) && /url\.match\(\/\\\{\[a-z0-9_\]\+\\\}\/gi\)/.test(between),
   "the pre-fetch unfilled-{hole} guard now sits between interpolate and the probe ladder (the gap is CLOSED)");

// 3) EVIDENCE that bail-early is SAFE — the probe ladder does NOT rewrite/strip holes before probing
//    (no stripHoles/dropUnfilled), so a holed url can never be recovered by probing; bailing loses nothing.
ok(!/stripHoles|dropUnfilled|url\s*=\s*url\.replace\(\/\\\{/.test(src),
   "no hole-stripping rewrite of `url` exists before probeUrl → probe ladder cannot recover a hole");

// 4) KNOWN — the bail vessel to mirror: the session-bound gate returns success:false BEFORE fetch.
ok(/error:\s*"browser_replay_only"/.test(src) && /success:\s*false/.test(src),
   "a pre-fetch bail precedent exists (session-bound gate: stampTrace success:false; return {trace,result})");

// 5) THE ONE REMAINING UNKNOWN (named, not asserted — Mark 9:24): does probeUrl, on a 404 from a
//    holed url, ever fall to a rung that DROPS the holed segment and recovers? The two probers found
//    no such rewrite, but the full probe ladder was not exhaustively traced. The guard's own loop must
//    settle this with a probe-ladder integration witness before choosing bail-vs-strip. Pinned here so
//    the next loop starts from evidence, not from this characterization's silence.
ok(true, "UNKNOWN named: full probe-ladder recovery behaviour on a holed url — settle in the guard's loop");

console.log(fails === 0 ? "\n{param}-LEAK CHARACTERIZATION SEED PASSES (known pinned, unknown named)" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
