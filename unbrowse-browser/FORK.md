# Unbrowse fork of agent-browser

The browser the Unbrowse node drives when an agent browses by hand. Upstream is
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0). This tree is upstream
**v0.43.0** with one added module and a few marked lines.

## The rule

Everything Unbrowse adds lives in `cli/src/native/unbrowse/`. Upstream's files only call into it, from lines
marked `Unbrowse fork:`. Nothing else in this tree differs from upstream: no file is removed, renamed or
reformatted. A change that needs more than a call from an upstream file belongs in the module, or in the node.

`grep -rn "Unbrowse fork" cli --include='*.rs' --include='*.toml'` lists every line outside the module.

## What the module adds (`cli/src/native/unbrowse/`)

| File | What | Why the node needs it |
| --- | --- | --- |
| `capture.rs` | With `UNBROWSE_CAPTURE_DIR` set, each session appends `<dir>/<session>.jsonl`: every finished request as a HAR 1.2 entry with the headers really sent and received (`Network.*ExtraInfo`, so `Cookie` and `Set-Cookie` are there), POST bodies Chrome held back, text response bodies, each redirect hop on its own line; every page-driving action with the field's own name and a locator; socket frames; downloads. A value typed into a password, one-time-code or card field is written as a name (`secret:<n>`), never as typed; the list of names is sealed beside the log with the browser's at-rest key (`auth.rs`), so a restarted daemon goes on naming them. `capture_forget {value}` names a value after the fact. | The node learns routes from this log. Upstream's HAR has no cookies and is not written as the page runs. |
| `tab.rs` | A command that carries `tab` (the CLI sets it from `AGENT_BROWSER_TAB`) runs in the tab with that label, made the first time it is named. Each tab's `@e` refs and frame are parked while another tab's command runs. A page a tab opened (a popup, a 3-D Secure window) belongs to that tab's session. | One browser per site, one tab per agent session. |
| `fill.rs` | `fill` with `site` (and `field`: `password`, `code` or `card`) checks, in an isolated world the page's script can't reach, that the field's own document is on that site and the field is made for that kind of secret, then writes the value into that element. Answers `field_checked` and, for a card in a payment provider's frame, `frame_origin`. With `username` and `code` it also fills the form's account-name field and, where the form marks one, its one-time-code field. With `submit` it submits the form at once, waits for the answer, and clears any field of the page that still holds the secret (a failed sign-in, or a site that shows the password back); it answers `submitted` and `cleared`. Also the `document` question (the main frame's loader id). | Vault logins and cards are filled by the node; an agent can't send `site` or `field`. |
| `eval.rs` | `eval --timeout <ms> <script>` gives the script that long (300 s at most), read off the front of its arguments. | Agents run scripts that wait on the page longer than a DevTools command's 30 s. |
| `world.rs`, `world.js`, `activation.js` | A caller's script (`eval`, `wait --fn`) runs in an isolated world of its own, where `document.cookie` and the page's storage read as `{session}`, IndexedDB, caches, workers and the Cookie Store API are gone, and no way into the page's own world is left (script elements, `on…` attributes, HTML from strings, `javascript:` addresses, `srcdoc`). The browser's commands that activate an element (click, keys, a newline typed, `find … click`) never run a script address in the page's world: read before, in a guard world, and checked at the moment of activation. `world_e2e.rs` holds its tests in Chrome. | An agent acts on a signed-in page and never carries the site's session away (SECURITY.md). These are the fork's `agent_world` as it stood before 21 November 2026. |
| `contract.rs`, `contract_cli.rs` | The node's contract with this browser: every command line the node builds, parsed as the CLI parses it (no browser), and the built binary run as the node runs it in Chrome (its flags, environment, plain-text answers, `--json` reads, socket questions with `noLaunch`, the site-bound fill, a tab named by `AGENT_BROWSER_TAB`, the capture log). Each holds a field, a word or an action the node reads, with the node's file. `contract_cli.rs` is its own test target (`cli/Cargo.toml`). | An upstream release that changes what the node relies on fails a test before a node built on it ships. |
| `tests-not-run.tsv` | The tests that need a browser that CI's Chrome pass skips, each with why: upstream's tests whose own `evaluate` probes the fork's agent world refuses (they pass on upstream and on the fork with the world off), and a few that fail on upstream or on the runner too. | So upstream's own suite runs on every pull request, and what it can't run here is on record. |
| `saved.rs` | `state clear <session>`, `state rename <old> <new>` and `state show <file>` act on the saved state they name, in the states folder. Upstream's dispatcher reads `path`/`name` while its parser sends `sessionName`/`oldName`/`newName`, so `state clear <name>` deletes every saved state, `rename` always fails and `show` reads the working folder (upstream 0.43.0 and main). | A saved sign-in the owner keeps must not go when another one is cleared. |
| `network.rs` | `responsebody` reads a response's body once Chrome has finished loading it (`Network.loadingFinished` or `loadingFailed`), not at `responseReceived`, where Chrome answers "No data found for resource". | An agent reading a response body gets the body. |
| `surface.rs`, `surface_cli.rs`, `handlers_e2e.rs` | Upstream's own command surface. `surface.rs`: the parser's error and success lines (no browser). `surface_cli.rs` (its own test target, `cli/Cargo.toml`): the built binary against a stand-in daemon socket; each MCP tool must send the daemon what its documented command line sends, wrong MCP arguments are refused before anything runs, and `main.rs`'s own paths (session id, profiles, `close --all`, `--json` errors, `batch`, saved states). `handlers_e2e.rs`: the daemon's handlers in Chrome (frames, waits, dialogs, keys, touch, windows, clipboard, routes, `responsebody`, `requests`, snapshots, screenshot diffs, vitals). | An upgrade that changes what an MCP tool or command sends, or what a handler does, fails a test. |
| `help_pages.rs`, `printed.rs`, `doctor_cli.rs`, `chat_cli.rs`, `dashboard_cli.rs`, `features_cli.rs` (modules of `surface_cli.rs`); `flags_table.rs`, `chrome_search.rs`, `features.rs`, `provider_stubs.rs`, `webdriver_stub.rs` | The rest of upstream's surface the node ships but never calls, held without Chrome. Against the built binary: every command's `--help` page (and every example on a daemon command's page is a line the parser takes), the plain-text printers for each reply shape, `doctor --offline --quick [--fix]`, `chat` against a stub AI gateway, the dashboard server's HTTP API and lifecycle, `skills` and `plugin`. In process: global flags, which Chrome is found (install's, system, Puppeteer, Playwright), the React Suspense report, cloud browser providers against stub APIs, WebDriver/Appium/iOS against a stub server and fake `xcrun`. | An upgrade that changes a page, a printed answer, a check, a request or the Chrome the CLI launches fails a test. |
| `busy.rs` | While a command holds the daemon, `tab_list`, `cdp_url` and `capture_forget` are answered from what was noted after the last command (a forget is queued). A request with `noLaunch: true` never launches a browser. | The node's own housekeeping must not wait behind an agent's long command. |

The capture log's file format (`CaptureLog`) is the node's: `cli/Cargo.toml` depends on
`unbrowse-node/crates/browser` by path, so the node and this CLI write one format.

## Lines in upstream's files

| File | Lines |
| --- | --- |
| `cli/Cargo.toml` | the path dependency on the node's engine crate; the `[[test]]` targets `unbrowse_contract_cli` and `unbrowse_surface_cli` |
| `cli/src/native/mod.rs` | `pub mod unbrowse;` |
| `cli/src/native/auth.rs` | `ensure_encryption_key` made `pub(crate)`, for the capture log's sealer |
| `cli/src/main.rs` | `attach_tab_to_command` and its two calls |
| `cli/src/commands.rs` | `eval` takes `--timeout` off the front and stamps `timeout` on the command |
| `cli/src/native/browser.rs` | `to_ai_friendly_error` keeps a timed eval's own words, and its test |
| `cli/src/native/daemon.rs` | `busy::while_held` before the state lock is taken |
| `cli/src/native/actions.rs` | `world::before_activation` and `world::after_activation` around the dispatch, its first two arms (a refused activation, a caller's script), and `world::found` in `execute_subaction`; the `unbrowse` field of `DaemonState`; every drained event goes to `capture.on_event` and `tabs.on_event`; `capture::after_drain` after each drain; `before_command`, `tab::enter`, `before_action` / `after_action` around a command's handler; three match arms (`fill` bound to a site, `document`, timed `evaluate`); `capture::close` when the session closes; `handle_tab_new` and `handle_tab_switch` made `pub(super)`; `network::loaded` in `handle_responsebody` before the body is read |
| `cli/src/native/state.rs` | `saved::by_name` at the top of `dispatch_state_command` |

## What the fork no longer does

Before 21 November 2026 the fork was a rewrite of about 25,000 lines on upstream 0.39.1. These went with it;
upstream's behaviour stands in their place:

- Refusing engines, remote browser providers, `launch.mutate` plugins and the `human` input mode
  (`unbrowse_policy.rs`). The node never asks for any of them.
- Daemon ownership proofs, owner-only files, the Windows door key, file-root limits (`owner_only.rs`,
  `file_root.rs`), `AGENT_BROWSER_OWNER_PID`, `AGENT_BROWSER_RUNTIME_DIR`, `AGENT_BROWSER_NO_SANDBOX`.
- The dashboard's chat history, session settings and lifecycle edits.

The engine the node links for walks (`mint`, CDP launch, the capture log's format) is not fork code and lives
in `unbrowse-node/crates/browser`.

## Taking an upstream release

1. Replace this tree with the new release, keeping `FORK.md` and `cli/src/native/unbrowse/`.
2. Re-add the marked lines above; `git diff` against the previous release shows each one.
3. `cargo test --manifest-path cli/Cargo.toml unbrowse::`, then the tests that need a browser as CI runs them
   (`-- --ignored --test-threads=1 --exact`, skipping `tests-not-run.tsv`): the node's contract
   (`--test unbrowse_contract_cli`) must pass unchanged, and a line of `tests-not-run.tsv` whose test passes again
   goes. Then the node's `learn_shop` and `replay_shop` tests with `UNBROWSE_BROWSER` set to the new binary, then
   drive a page through a node built from the branch.
