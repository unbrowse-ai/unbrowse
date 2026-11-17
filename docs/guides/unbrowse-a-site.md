# Unbrowse a site

Turning a site you can browse into a route you can call. Most of the time there is nothing to do by hand: ask for
what you want, and the node learns on the way.

## The easy path

```sh
unbrowse do "<what you want>" --url "<a page that does it>"
```

The node's browser walks that page once, keeps the call that answers the goal, works out which of its values are your
inputs, and saves it as a route (`api/goal.rs` `do_goal`, `learn.rs`). The next ask with the same goal is a call. How the
walk becomes a route: [ARCHITECTURE.md §3](../ARCHITECTURE.md#3-the-pipeline-browse-once-call-forever).

Pick a URL that **already shows the thing**: a results page for a query, an item's page for its id. A value in the
URL (`?q=tokio`, `/item/123`) becomes the route's input, so a new value is a new call, not a new walk. Keep the same
goal words: they are how the node finds the route again. When routes on two sites do the goal, the node asks for a
`url` to say which.

Before it walks anything, the node tries the routes other nodes list for the page's site, and pays a fetch fee by
itself if one does the goal ([SHARING.md §3](../SHARING.md#3-how-a-caller-finds-pays-for-keeps-and-runs-a-body)).

## When a page needs hands

When loading the page doesn't answer the goal (a form, a filter, a flow behind a sign-in), `do` answers
`how: "browse"` with the page open in the node's browser and a snapshot of it. Drive it from there. A snapshot gives
each control a ref (`@e1`, `@e2`, …) to act on:

```sh
unbrowse browse open "https://example.com/login"
unbrowse browse snapshot -i
unbrowse browse fill @e3 "me@example.com"
unbrowse browse fill @e4 vault:example.com:me
unbrowse browse click @e5
```

The commands an agent may send are the page-driving ones (`browse.rs` `COMMANDS`): `open`, `goto`, `snapshot`,
`click`, `dblclick`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `focus`, `scroll`, `upload`,
`get`, `is`, `find`, `wait`, `back`, `forward`, `reload`, `eval`, `screenshot`, `close`, and `ask_owner`. None of them
picks another browser, profile or session. `--site` names the site's browser to use.

The node records every step and learns as you go: a call that sends what you typed becomes a route as soon as it
lands, and a page you only read becomes one when you leave it. Each reply lists what was learned (`learned`); opening a
page with a goal a route already does names that route (`route_for_goal`). From then on, call the route and stop
driving the flow.

The node learns from the site's own calls, never from yours: the requests an `eval` script makes (a `fetch` of your
own) are not learned, and its reply says so; driving the page (`click`, `fill`, `press`) is what teaches a route. A
step that needs the owner says so instead of reporting done (`browse.rs` `came_to`): a click after which the page has
the same address and the same text, and a page that landed on a sign-in naming the one asked for to come back to,
answer `needs_owner: true` with `next: ["ask_owner", …]`.

## Signing in

- **A login the vault holds.** Fill the field with its reference, `vault:<site>:<account>`; the node types the
  password and you never see it. `vault:code:<site>:<account>` fills its one-time code; `vault:new:<site>:<account>`
  makes a fresh derived password for a sign-up and keeps it. The route keeps the reference as its secret input, so
  later calls sign in again from the vault with no browser (`vault.rs`).
- **A session from your browser.** Import the site's cookies once and the first call is already signed in
  ([sessions-and-passwords.md](sessions-and-passwords.md)).
- **A page only a person can pass.** `unbrowse browse ask_owner "sign in so I can read your messages"` shows the page
  on the window's Browser screen and waits for the owner ([the-app.md](../start/the-app.md#what-the-node-asks-you)). A sign-in
  done by hand never becomes a route; the session it earned stays in the site's profile.

## Keeping a site out

Add a site to **Settings**, **Mapping** (the `excluded` setting) and the node never learns from it: a walk or a browse
there is refused before the browser opens (`browse.rs` `excluded`, `learn.rs`), no route calls it, and no heal walks
it again (`run.rs` `call_with`). A host excludes its whole site's browser. A route that reaches an excluded site is
never shared ([SHARING.md §4](../SHARING.md#4-automatic-sharing)).

Related: [Learn a route while browsing](learn-a-route.md) · [The agent skill](../reference/the-skill.md).
