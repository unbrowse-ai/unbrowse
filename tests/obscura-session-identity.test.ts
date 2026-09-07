/**
 * A session's tab id must be ASKED FOR, not assumed.
 *
 * The measured failure, end to end: `go` opened defillama on an obscura broker
 * and reported ok:true — truthfully; the page really was loaded. But the session
 * was persisted with the hard-coded placeholder `obscura-page`, while this
 * obscura build cannot `browser_tab_new` yet happily `browser_tab_list`s the
 * page it has, as `tab-1`. Liveness compares the recorded id against discovery,
 * found no match, pruned the session, and `run-js` answered `no_active_session`
 * for a page that was loaded and evaluable the whole time:
 *
 *   [browse-liveness] not live {"tab_id":"obscura-page","reason":"tab_not_in_discover",
 *                               "discovered_tab_ids":["tab-1"]}
 *
 * Two constants pretending to be identities, one on each side of a process
 * boundary. Every existing obscura test passed throughout — they asserted the
 * placeholder was returned, which is exactly what the code did.
 *
 * Hermetic: canned transport, no broker, no browser.
 */

import { test, expect, describe } from "bun:test";
import {
  ObscuraBrowseSessionClient,
  OBSCURA_SINGLE_TAB,
} from "../src/obscura/browse-session-client.js";
import { ObscuraHttpClient } from "../src/obscura/session-broker.js";
import { isBrowseSessionLive, type BrowseSession } from "../src/api/browse-session.js";
import type { BrowseSessionClient } from "../src/api/browse-session.js";

/** An ObscuraHttpClient whose transport is a canned tool->reply map. */
function fakeClient(replies: Record<string, string>) {
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    const req = JSON.parse(init.body);
    if (req.method !== "tools/call") return { text: async () => JSON.stringify({ result: {} }) };
    const name = req.params.name as string;
    if (!(name in replies)) throw new Error(`tool ${name} unsupported`);
    return {
      text: async () =>
        JSON.stringify({ result: { content: [{ type: "text", text: replies[name] }] } }),
    };
  }) as unknown as typeof fetch;
  return new ObscuraHttpClient(1234, fetchImpl);
}

/** The build this repo actually vendors: lists tabs, cannot open one. */
const LISTS_BUT_CANNOT_OPEN = {
  browser_tab_list: '* tab-1  https://defillama.com/  "DefiLlama - DeFi Dashboard"',
  browser_evaluate: "https://defillama.com/",
};

describe("newTab agrees with discoverTabs — they are compared across a process boundary", () => {
  test("a build that cannot OPEN a tab adopts the id it can LIST", async () => {
    const c = new ObscuraBrowseSessionClient({ client: fakeClient(LISTS_BUT_CANNOT_OPEN) });
    await c.start();
    // The whole bug in one assertion: this returned OBSCURA_SINGLE_TAB.
    expect(await c.newTab()).toBe("tab-1");
  });

  test("whatever newTab returns, discoverTabs must contain it", async () => {
    // The invariant, stated directly rather than by example — this is the
    // relationship liveness depends on, so it is the one worth asserting.
    for (const replies of [LISTS_BUT_CANNOT_OPEN, { browser_evaluate: "about:blank" }]) {
      const c = new ObscuraBrowseSessionClient({ client: fakeClient(replies) });
      await c.start();
      const opened = await c.newTab();
      const discovered = (await c.discoverTabs()).map((t) => t.id);
      expect({ opened, discovered }).toEqual({ opened, discovered: [opened] });
    }
  });

  test("a build with NO tab model still gets the placeholder — unchanged", async () => {
    const c = new ObscuraBrowseSessionClient({ client: fakeClient({ browser_evaluate: "about:blank" }) });
    await c.start();
    expect(await c.newTab()).toBe(OBSCURA_SINGLE_TAB);
  });
});

describe("liveness: the recorded identity decides whether a session survives rehydrate", () => {
  const session = (over: Partial<BrowseSession>): BrowseSession =>
    ({ sessionId: "s1", tabId: "tab-1", url: "https://defillama.com/", domain: "defillama.com", harActive: false, ...over }) as BrowseSession;

  const client = () =>
    new ObscuraBrowseSessionClient({
      client: fakeClient(LISTS_BUT_CANNOT_OPEN),
    }) as unknown as BrowseSessionClient;

  test("the broker-reported id survives", async () => {
    expect(await isBrowseSessionLive(session({}), client())).toBe(true);
  });

  test("the placeholder does NOT — this is what run-js hit", async () => {
    // Deliberately asserting the FAILURE: the placeholder is not merely
    // cosmetic, it is fatal, and a future change that reintroduces it at the
    // import site must fail here rather than in a live browser.
    expect(await isBrowseSessionLive(session({ tabId: OBSCURA_SINGLE_TAB, url: "" }), client()))
      .toBe(false);
  });

  test("a rehydrated session with no url cannot be rescued by drift-adoption", async () => {
    // Why the fix had to be at the SOURCE. Liveness will adopt a lone drifted
    // tab, but only on an exact url match — and it is right to refuse without
    // one (adopting a blank-url tab is the wrong-tab wedge). An import that
    // records `url: ""` therefore has no second chance.
    expect(await isBrowseSessionLive(session({ tabId: "stale", url: "" }), client())).toBe(false);
  });
});
