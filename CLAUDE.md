# CLAUDE.md

AGENTS.md holds the strategy and the pattern. One rule on top of it:

## Fixes are general, never hard-coded

A site that breaks is a case of a class. Fix the class.

- **No site, vendor or host names in the engine, the learner or the transport.**
  No `if host == "sistic.com.sg"`, no list of ad or analytics hosts to skip,
  no path that only one site uses.
- **State the rule as a property of the walk.** Say what the call does, read
  from its own traffic: "a call that sends the walked page's own address is
  reporting the page, not answering it". Not "googleadservices is noise".
- **Site names belong in tests, as fixtures.** A regression test may be built
  from the walk that exposed the bug, named for the property it checks
  (`a_call_reporting_the_page_never_wins`), not for the site.
- **No lists of names to grow.** The old `NOISE` and `GATEKEEPER_HOSTS` lists
  were replaced by properties of the walk (`Trace::door`, a call reporting the
  page, a cookie only a browser can earn). When something new slips through,
  find the property it stands for and test that, never add its name.
- **Before finishing, check the fix against a site that isn't the one in
  front of you.** If it only works because of that site's names, it isn't the
  fix yet.

## The meta pattern: propose from the walk, let the site verify

The rule above is how a *fix* stays general. The same shape covers a route the
learner cannot work out generically, and it is the pattern to reach for before
writing any special case:

- **The walk is the asset.** A route is data read from it: the call, the
  caller's values, the page it carries, the producer it needs. The engine learns
  by reading the capture, not by reconstructing a site.
- **Generation proposes; the engine applies; the site verifies.** A model or a
  search may propose a *shape* from the walk — which step is the answer, which
  value is the caller's, which page to carry, which producer to run. It never
  ships as per-site code. The proposal is applied to the same generic graph and
  is kept only if replay passes: a second value changes the answer, a nonsense
  value finds nothing, a recheck matches, no write is sent twice.
- **Generative at learn/repair time only.** The call path is deterministic,
  warm HTTP. A model in the call path loses the route.
- **Generated code stays in the sandbox.** A program that reproduces a
  page-computed value runs only in the restricted sandbox, is the route's
  private data, and is never shared as code (shared routes carry no code).
- **A wall is a problem, not a boundary.** A captcha, Turnstile or DataDome is a
  step to satisfy like any other: meet it with the browser, the transport or a
  solver, keep the fix general, and say so plainly. Unbrowse is open about
  bypassing anti-bot; what it never ships is a fake success. A wall that still
  holds is an honest failure, and the site's answer remains the judge.
- **A property, not a vendor.** When a new site exposes a gap, name the property
  of the walk it stands for and fix that: “a value the page's address carries
  into its call is an input”, “a module script runs as a module”, “a page the
  route carries is not a live door”. The site that exposed it stays in a test
  fixture.

Worked examples: Substack's `/search/<term>` became an input because the
address handed the value to the call, not because Substack is special; Etsy's
vendor chunk ran as a module because the document said `type="module"`, not
because Etsy is special. The browser remains the fallback for a page that will
not boot, and the site's answer remains the judge.
