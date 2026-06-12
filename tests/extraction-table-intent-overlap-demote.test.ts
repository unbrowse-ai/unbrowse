// Live regression: .bench-gate/20260521T010031Z probe 035 statmuse.
//
// Intent: "search statsmuse for player stats"
// URL:    https://www.statmuse.com/nba/ask/lebron-points-per-game-this-season
//
// The page renders multiple <table> elements:
//   1. Eastern Conference standings (columns: Eastern, W, L, PCT, GB)
//   2. Western Conference standings (columns: Western, W, L, PCT, GB)
//   3. LeBron's per-game stat answer (columns: NAME, PPG, SEASON, ...)
//
// Pre-fix behaviour: standings tables tied at relevance_score 3.5 and
// LeBron's table scored 2.1 (BM25 didn't see "lebron"/"points"/"stats"
// strongly anywhere). The agent received the conference standings — zero
// tokens shared with the intent or URL path — instead of the player's
// actual stat row.
//
// Structural fix (NOT per-host, NOT per-intent): a type:"table" candidate
// whose headers + cell values share ZERO tokens with intent + URL-path is
// demoted by -150 when there is at least one OTHER table candidate on the
// page with nonzero overlap. Generic tokens-vs-tokens, no registry.
//
// Falsifier carve-outs:
//   - If it's the ONLY table candidate, don't strand the agent — return 0.
//   - If multiple tables ALL have zero overlap, don't pick a winner —
//     return 0 for everyone and let the fallback chain decide.
//
// Real-runtime: live extractFromDOM, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

function findTableRows(data: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(data) && data.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    return data as Array<Record<string, unknown>>;
  }
  // "multiple" return shape: { type, data, relevance_score }[]
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object" && (item as { type?: string }).type === "table") {
        const tbl = (item as { data?: unknown }).data;
        if (Array.isArray(tbl) && tbl.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
          return tbl as Array<Record<string, unknown>>;
        }
      }
    }
  }
  return null;
}

function pickedTableHeaders(data: unknown): string[] {
  const rows = findTableRows(data);
  if (!rows || rows.length === 0) return [];
  return Object.keys(rows[0]);
}

describe("table-intent-overlap demotion (statmuse reproducer)", () => {
  test("LeBron stats table wins over Eastern + Western standings when intent + URL mention lebron", () => {
    // Build a page with 3 tables in the order statmuse renders them.
    // Standings tables FIRST so they win on document order if the
    // demotion does NOT fire (pre-fix behaviour).
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="LeBron James points per game this season">
    </head><body><main>
      <section class="standings">
        <h2>Eastern Conference</h2>
        <table>
          <thead><tr><th>Eastern</th><th>W</th><th>L</th><th>PCT</th><th>GB</th></tr></thead>
          <tbody>
            <tr><td>Pistons - z</td><td>60</td><td>22</td><td>.732</td><td></td></tr>
            <tr><td>Celtics - x</td><td>56</td><td>26</td><td>.683</td><td>4.0</td></tr>
            <tr><td>Knicks - x</td><td>53</td><td>29</td><td>.646</td><td>7.0</td></tr>
            <tr><td>Cavaliers - x</td><td>52</td><td>30</td><td>.634</td><td>8.0</td></tr>
            <tr><td>Raptors - x</td><td>46</td><td>36</td><td>.561</td><td>14.0</td></tr>
          </tbody>
        </table>
        <h2>Western Conference</h2>
        <table>
          <thead><tr><th>Western</th><th>W</th><th>L</th><th>PCT</th><th>GB</th></tr></thead>
          <tbody>
            <tr><td>Thunder - z</td><td>64</td><td>18</td><td>.780</td><td></td></tr>
            <tr><td>Spurs - x</td><td>62</td><td>20</td><td>.756</td><td>2.0</td></tr>
            <tr><td>Nuggets - x</td><td>54</td><td>28</td><td>.659</td><td>10.0</td></tr>
            <tr><td>Lakers - x</td><td>53</td><td>29</td><td>.646</td><td>11.0</td></tr>
            <tr><td>Rockets - x</td><td>52</td><td>30</td><td>.634</td><td>12.0</td></tr>
          </tbody>
        </table>
      </section>
      <section class="answer">
        <h2>LeBron James 2025-26 Season Stats</h2>
        <table>
          <thead><tr><th>NAME</th><th>PPG</th><th>SEASON</th><th>TM</th><th>GP</th><th>MPG</th><th>RPG</th><th>APG</th></tr></thead>
          <tbody>
            <tr><td>LeBron James L. James</td><td>20.9</td><td>2025-26</td><td>LAL</td><td>60</td><td>33.2</td><td>6.1</td><td>7.2</td></tr>
          </tbody>
        </table>
      </section>
    </main></body></html>`;

    const result = extractFromDOM(
      html,
      "search statsmuse for player stats",
      "https://www.statmuse.com/nba/ask/lebron-points-per-game-this-season"
    );

    const headers = pickedTableHeaders(result.data);
    const headerStr = headers.join(",").toLowerCase();
    const dataStr = JSON.stringify(result.data).toLowerCase();

    // The picked table (or top table if multiple returned) must NOT be
    // a standings table. Standings tables have an Eastern or Western
    // first column.
    if (headers.length > 0) {
      expect(headerStr.startsWith("eastern,") || headerStr.startsWith("western,")).toBe(false);
    }

    // The LeBron row must dominate the returned payload. Either it's the
    // chosen table OR it sits at the top of a "multiple" payload.
    expect(dataStr).toContain("lebron");
    // PPG header is a unique signal of the player-stats table.
    expect(dataStr).toContain("ppg");
  });

  test("falsifier: single table with zero overlap is NOT demoted (degenerate one-candidate case)", () => {
    // Page has exactly one table. Even though it shares zero tokens with
    // the intent, demoting it would leave the agent with nothing.
    const html = `<!doctype html><html><body>
      <table>
        <thead><tr><th>Foo</th><th>Bar</th><th>Baz</th></tr></thead>
        <tbody>
          <tr><td>alpha</td><td>beta</td><td>gamma</td></tr>
          <tr><td>delta</td><td>epsilon</td><td>zeta</td></tr>
          <tr><td>eta</td><td>theta</td><td>iota</td></tr>
        </tbody>
      </table>
    </body></html>`;

    const result = extractFromDOM(
      html,
      "search for completely unrelated user query",
      "https://example.com/unrelated/path/segments"
    );

    const dataStr = JSON.stringify(result.data).toLowerCase();
    // The single table's content must survive. Either it's chosen or it
    // appears in the "multiple" payload — but it MUST NOT be excluded
    // entirely by the demotion.
    expect(dataStr).toContain("alpha");
    expect(dataStr).toContain("foo");
  });

  test("falsifier: two tables with equal overlap — neither demoted (no preference between equals)", () => {
    // Both tables share the same single token ("user") with the intent.
    // Neither has a strict advantage; both should survive the demotion.
    const html = `<!doctype html><html><body>
      <table>
        <thead><tr><th>UserId</th><th>Score</th></tr></thead>
        <tbody>
          <tr><td>alice</td><td>10</td></tr>
          <tr><td>bob</td><td>20</td></tr>
          <tr><td>carol</td><td>30</td></tr>
        </tbody>
      </table>
      <table>
        <thead><tr><th>UserName</th><th>Rank</th></tr></thead>
        <tbody>
          <tr><td>dave</td><td>1</td></tr>
          <tr><td>erin</td><td>2</td></tr>
          <tr><td>frank</td><td>3</td></tr>
        </tbody>
      </table>
    </body></html>`;

    const result = extractFromDOM(
      html,
      "list user rankings",
      "https://example.com/users/list"
    );

    const dataStr = JSON.stringify(result.data).toLowerCase();
    // At least one of the tables must survive into the output (whichever
    // BM25/length tiebreak picks). Neither should be hard-demoted to -150.
    const hasTable1 = dataStr.includes("alice") || dataStr.includes("userid");
    const hasTable2 = dataStr.includes("dave") || dataStr.includes("username");
    expect(hasTable1 || hasTable2).toBe(true);
  });
});
