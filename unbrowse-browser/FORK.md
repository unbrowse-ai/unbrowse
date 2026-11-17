# Unbrowse fork of agent-browser

The Unbrowse node's browser sidecar. Upstream: `vercel-labs/agent-browser` (remote `upstream`), forked at `dac13bb` (0.39.1).

The fork stays a thin patch so upstream updates rebase cleanly. Upstream code is left in place and refused where it would take effect.

## What the fork refuses (`cli/src/unbrowse_policy.rs`)

| Feature | Why | Checked in |
| --- | --- | --- |
| Obscura engine | Disguises itself as Chrome on Windows and fakes its fingerprint; doesn't report request headers or bodies | `native/browser.rs` launch |
| Remote browser providers (Browserbase, Browserless, Browser Use, Kernel, AgentCore, plugin providers) | The user's sessions and traffic would leave their machine | `native/providers.rs` |
| `launch.mutate` plugins | How stealth and captcha plugins attach | `plugins.rs` |
| `human` input mode | Moves the pointer along eased curves to look like a person | `native/actions.rs` `execute_command` |

Engines allowed: Chrome (default) and Lightpanda. Lightpanda always launches with `LIGHTPANDA_DISABLE_TELEMETRY=true` (`core/src/cdp/lightpanda.rs`).

Why: browsing stays on the user's machine (Node app PRD FR-4), and the
fork ships only Chrome's own settings, never third-party stealth engines.

## Headless by default, headed when a person is needed

The node runs Chrome headless. When the engine's `mint()` meets a page that
refuses it, it asks again in a browser that remembers nothing, then with a
window, and what the site accepts takes the profile's place (the old one is
kept under `refused/`). Only a refusal does that: a page that never answered
(slow, unreachable, a browser that stopped talking) refused nothing, so it is
asked again with a window in the same profile, and the profile stays. No window
appears for sites whose door the headless browser clears. The swap's two renames
are recorded first (`.<profile>.replacing`), and the next launch of that profile
finishes one a process died in (`core/src/session.rs` `finish_replacing`).

A profile under `refused/` is never removed by the engine, `doctor --fix` included: any one may hold a sign-in. The
engine notes each `refused/` folder it uses in `~/.agent-browser/set-aside` (`paths::set_aside_index`), and `doctor`
lists every profile kept there with its size and age (`cli/src/doctor/profiles.rs`), so the owner can remove the ones
they don't want.

## What the fork adds

| Change | Where | Why |
| --- | --- | --- |
| HAR includes the headers actually sent and received, including `Cookie` and `Set-Cookie`, from Chrome's `Network.*ExtraInfo` events, whichever order they arrive in, and each redirect hop gets its own (`HarExtras`) | `native/actions.rs` | Route learning has to trace session state; the main network events leave cookies out |
| Passive capture: with `UNBROWSE_CAPTURE_DIR` set, each session appends `<dir>/<session>.jsonl`: every finished request (a HAR entry, with cookies and text bodies) and every page-driving action with what was typed. A value typed into a password, one-time-code or card field is marked secret, whichever command typed it (`fill`, `type`, `keyboard` and `inserttext` into the focused field, `setvalue`, a locator's `fill`). A saved login's password (`auth login`) and any command's `password`, with the form HTTP Basic sends it in, are named too. A typed field also records its own identity (`name`, `id`, `aria-label`, label text, then placeholder, first non-empty), so learned routes name inputs the way the page does instead of by CSS selector. Chrome holds a blob's or file's body back (`hasPostData` without inline data, measured on Chrome 155; a string comes inline at any size); those are fetched with `Network.getRequestPostData` after the event drain, so a POST-heavy flow (a purchase) captures its bodies. A held-back body answered by a redirect stays bodyless, because Chrome has moved the id on by then, as do beacon requests Chrome itself discards (no `hasPostData` at all). | `native/capture.rs`, hooks in `native/actions.rs` | "Map while browsing": the node learns routes from what the agent already does, with no recording commands |
| A compacted dashboard chat keeps its summary: the browser sends it back as a `system` message on every later turn, keeps every message the server kept, and compacting again changes nothing. Summarizing cuts a long message on a character's edge | `packages/dashboard/src/lib/chat-compaction.ts`, `components/chat-panel.tsx`, `native/stream/chat.rs` `cut_at_char` | The server holds nothing between turns, so the turn after a compaction had neither the old messages nor the summary while the chat said they were summarized. A message with a multi-byte character at byte 2000 panicked the request |
| A state file that won't load stops an auto-launch as it stops `launch` | `native/actions.rs` `auto_launch_inner` | `--state` reaches a new daemon through the environment, and the auto-launch path dropped the error, so a session that asked for a login ran logged out with nothing said |
| A WebMCP call belongs to the page it runs in: opening or switching tabs leaves it running, its answer is read from whichever tab it's on, and a cancel goes there. Only that page navigating or closing fails it. `webmcp result --timeout` running out says `pending` and leaves the tool running | `native/webmcp.rs` `InvocationRecord::page_session`, `native/actions.rs` `WebmcpDeadline` | Any tab change, in any session sharing the browser, failed every pending call, and polling a detached call for its result cancelled the tool it was asking about |
| A click's cover check (`BLOCKER_AT_JS`) lets a cover that is part of the target's own control through: when the nearest element holding both the target and what sits over it holds no other control (and isn't the page's body), the click is the control's. A ripple over a styled checkbox's input, or the paragraph showing a select's value over its input, was refused as "covered" | `native/element.rs` | Component libraries draw their controls over the native input and take the click on the wrapper; refusing it left an agent no way to tick a box or open a select |
| A page's one screencast has two owners, `screencast start` and the stream's viewers, and it stops only when neither wants it: the last viewer leaving or the stream turning off keeps a cast the command holds, and `screencast stop` keeps a cast viewers are watching. With no viewer the daemon acks the frames | `native/stream/cdp_loop.rs`, `native/stream/mod.rs` `hold_screencast`, `native/actions.rs` | Each side stopped the cast the other was using: the daemon went on saying active and refused a new start, and a viewer's picture froze |
| The dashboard shows a device, colour scheme, offline switch or HAR recording only once its command took, says why when it didn't, and remembers each per session | `packages/dashboard/src/lib/session-settings.ts`, `store/session-settings.ts`, `components/viewport.tsx`, `components/network-panel.tsx` | A refused command still read as applied, and coming back to a session showed defaults while its browser stayed dark, offline or recording |
| A take that ended by itself is noticed: the next response warns, the stream stops showing it as recording, a new take can start and `record stop` still reports it. `close` finishes the take. An encoder that falls behind ends the take with the file finished (`cutShort`). `record restart` stops the old take only after its navigation worked | `native/recording.rs`, `native/actions.rs` `close_take`, `handle_recording_restart` | `active` only meant a take was started: a dead task was found at `record stop`, the stream flag stuck on a failed stop, one stall dropped ffmpeg and with it the whole file, and a closed browser left a take that never finished and blocked the next |
| A Safari or iOS session keeps its WebDriver backend past the first command | `native/actions.rs` `execute_command` | With no CDP browser, every later command launched a local Chrome and ran there while the backend still said WebDriver |
| `network requests` keeps the newest 5,000 requests | `native/actions.rs` `track_request` | Tracking never switches off once on, and a stream keeps it on for the daemon's life, so the list grew for as long as the daemon ran, each entry holding its headers and POST body |
| `download` ends on its own file's completion, not another tab's, and puts the browser's download behaviour back as the launch set it | `native/actions.rs` `download_news`, `restore_download_behavior` | Any download finishing ended the wait, so the file could be renamed while Chrome was still writing it, and `allowAndName` stayed on: every later download landed in that folder named by a guid |
| The dashboard's storage panel reads the answer inside the CLI's `--json` response (`data`), says why when a read failed instead of showing an empty store, and shows only the newest read | `packages/dashboard/src/lib/cli-output.ts`, `components/storage-panel.tsx` | Cookies read as empty and a storage dump listed `success`, `data`, `error` as the page's keys. The dashboard's rules are plain modules tested with `bun test src`; `tsconfig.json` leaves `*.test.ts` out of `next build`'s type-check, which has no `bun:test` types |
| What a page's worker asks for is recorded with the page's own traffic: `Network.enable` on the worker's session before it resumes, and its events kept for the HAR, `network requests` and capture (`is_recorded_worker_network_event`) | `native/actions.rs` | A worker reports on its own session, so a call a site makes from a worker reached none of them and the node never learned it |
| A dashboard session's rows and chat follow what really happened: "Starting..." and "Closing..." end on the command's answer or on time, a refused close says why, a closed session's chat is gone, what is cached for a port is dropped when the port changes hands, and each session keeps one chat that finishes and saves its turn while another session or side tab is on screen | `packages/dashboard/src/lib/session-lifecycle.ts`, `lib/chat-history.ts`, `lib/exec.ts`, `store/sessions.ts`, `store/chat-book.ts`, `components/chat-panel.tsx` | A failed close left a row with no menu for good, a chat cleared from `sessionStorage` lived in `localStorage`, and switching away mid-turn lost the turn while the browser kept going |
| A state save reads an origin's storage on a blank page it serves itself, and the site is never asked: the temp page keeps its Fetch pauses to itself (`CdpClient::subscribe_session`) and answers them while `Page.navigate` waits. `--headers` reach every tab, not only the one active the first time they were used | `native/state.rs`, `native/actions.rs` `handle_navigate` | Chrome answers `Page.navigate` only after the navigation commits, so the save sat waiting while the daemon's fetch handler let the pause go: every save and autosave really loaded every visited origin with the session's cookies. Fetch was enabled only on the first `--headers`, so a tab already open sent nothing |
| `fill` and `type` use a person's keys: the field's text is selected and deleted with Backspace (its own value setter only when the page refuses the key), then each character is a keyDown carrying its text and a keyUp, so the page sees keydown, keypress, beforeinput, input and keyup. Only a character with no key on a US layout is inserted with `Input.insertText`. Upstream inserted the whole value with `Input.insertText` (input events only) after setting `value = ''` | `native/interaction.rs` | A form that recomputes on key release (Vue/Vuetify `@keyup`) kept its old totals after a fill, and its model lost the value on save |
| The dashboard's stream answers only to its own socket: a lost connection clears the status and the picture and says so, and a socket closing late can't mark the next session down or reopen the old port | `packages/dashboard/src/lib/stream-link.ts`, `store/stream.ts`, `components/viewport.tsx` | The viewport kept a green dot on a frozen frame after the connection went, and a retry from the old session could take input from the new one |
| `--pin-tab` holds on a browser the daemon launched, not only on one it attached to, and a surviving runtime Chrome gets the session's tab back. A crashed renderer (`Inspector.targetCrashed`) refuses commands that need it with `tab_crashed` until it loads again | `native/actions.rs` `bind_launched_browser`, `crashed_page_refusal` | The tab rules ran only on attach, so a launched browser's pinned session moved to the neighbouring tab when its own closed. A crashed tab stays listed and its session stays open, so the next command waited 30 s and blamed the script |

Each request is stamped with the daemon's own clock when first seen (`HarEntry::seen_at`), the same clock actions use, because engines differ in timestamp precision (Lightpanda reports whole seconds). A finished request is written about 0.75 s after it finishes, because Chrome can report the cookies a request sent after its response has finished. A request answered but never finished is written 8 s after its answer came. Everything left is written when the session closes.

## A checkbox is clicked once (`native/interaction.rs` `click_took`)

`check` and `uncheck` give a control up to 500 ms to show a click took before the script fallback clicks it again: upstream read it at once, so a control that follows its click by a moment was toggled twice and ended wrong. A control that can't be read after the click took it, so a tick that takes the page elsewhere is a success.

## A checkbox is clicked once (`native/interaction.rs` `click_took`)

`check` and `uncheck` give a control up to 500 ms to show a click took before the script fallback clicks it again: upstream read it at once, so a control that follows its click by a moment was toggled twice and ended wrong. A control that can't be read after the click took it, so a tick that takes the page elsewhere is a success.

## A page a page opens has the session's identity (`native/actions.rs` `ready_target_for_its_first_document`, `publish_session_setup`)

The background task that resumes an auto-attached target is the one that readies it, so a popup or a frame has the session's user agent, time zone, locale, geolocation, headers and init scripts for its first document; upstream resumed it first and left that to a later tick. With any setup to carry, browser-level auto-attach goes on, since only that pauses a popup at birth. A tab this daemon opens has no opener and is set up by the command that opened it, so nothing runs twice. `window new` and pages found by event get the setup too, and `removeinitscript` reaches every copy. `prepare_domains` states the browser's own identity, so it says the session's user agent after it: every tab switch comes through there. A target that closes during setup is no longer a failure of the network controls, which closed the whole browser.

## Sessions share a browser, each in its own tab (`native/actions.rs` `enter_tab`, `main.rs` `attach_tab_to_command`)

The node runs one browser per site, in the site's profile, and several agents may browse the same site at once. Each
agent's session gets its own tab: the CLI stamps `AGENT_BROWSER_TAB` onto every command as `"tab": "<label>"`, and the
daemon, under its state lock, switches to the tab with that label before running the command, making it the first time
the label is named (the browser's lone blank first page is taken rather than left over). Tab management (`tab_*`),
`launch`, `close` and commands that touch no page run where they always did. What a tab's last snapshot numbered (its
`@e` refs) and the frame it was in are parked under its label while another tab's command runs, and come back with it,
so one session's commands never invalidate another's refs. While capture is on, a request from any of the browser's
own tabs is recorded, not only the active tab's: a session's page keeps loading while another session's command runs.
`BrowserManager::active_label` and `adopt_blank_active` are the two helpers this adds.

- **A page a session's tab opens is that session's** (`enter_tab`, `session_page`). A popup, a `target=_blank` page
  (`rel=noopener` too) or a 3-D Secure window is recorded with the page that opened it (`TargetInfo::opener_id`,
  kept in `DaemonState::opened_from`), and a command naming the tab runs in the newest such page still open, else in the
  tab itself. Once commands name tabs, a page found by event no longer becomes the active one under another session's
  command (`BrowserManager::keep_active`). Only the browser's lone first page is taken for a new label, never a page a
  session opened.
- **Closing one tab never clears another's refs** (`handle_tab_close`). Refs and the frame are cleared only when the
  page they were numbered on closes; the tab that becomes active then gets back what its session parked. Parked refs
  carry the page they were made on and come back only to it.

## A command acts where it was aimed

`wait --text` and `wait --fn` read the frame `frame` selected, as `wait <selector>` does. On Appium, `tap <selector>` taps the element (upstream pressed (200, 200) whatever it was given) and a tap aimed nowhere is refused.

## The node's housekeeping never waits behind a long command (`native/actions.rs` `WhileBusy`, `native/daemon.rs` `handle_connection`)

The daemon runs one command at a time under its state lock, and an agent's script may hold it for minutes. While it
does, three requests are answered without it: `capture_forget` is queued and named before anything else is written
(`capture::apply_queued`, run at the start of every command and every capture flush), so a secret the owner typed
leaves the walk record before any later line is written; `tab_list` and `cdp_url` are answered as they were after the
last command (`WhileBusy::publish`). A request carrying `"noLaunch": true` (the node's own, over the socket) is
refused instead of launching a browser, which would have none of the site's launch settings.

## A profile a running Chrome holds keeps that Chrome (`core/src/cdp/chrome.rs` `profile_held`)

Measured with Chrome 156 on macOS: a second Chrome on a live user-data-dir exits 21 within a second, except when both
have windows, where it hands its arguments to the first (a new window) and exits 0. Neither gives a debugger. Upstream's
launch deleted `DevToolsActivePort` first, which is the only way back to the live browser. So a launch checks the
profile's singleton socket and, if something listens there, starts nothing, touches nothing and says the profile is
open. The runtime pid file is written before the port file.
## A daemon writes down what it was started with (`cli/src/connection.rs` `DAEMON_CONFIG_ENV`, `native/daemon.rs`)
The CLI hands the fingerprint in `AGENT_BROWSER_DAEMON_CONFIG` and the daemon writes `<session>.config` before it listens,
so a CLI dying right after a start can't make the next one stop a healthy daemon.

## A session belongs to the process that holds it (`cli/src/connection.rs` `claim_session`, `native/daemon.rs` `run_daemon`)

Upstream took a session's files by their presence: any daemon could replace them and any CLI could delete them. Here a
daemon holds an operating-system lock on `<session>.lock` from before it touches anything until it dies, however it
dies. A second daemon leaves without touching a file, a cleanup takes the same lock first, and a process is signalled
only while it holds the lock (`owned_daemon_pid`), so a reused pid can't be hit. A session held by something nobody can
reach is stopped after 10 s (`settle_held_session`). Once a close has gone through, the daemon refuses what comes in behind it (`session_closing`, nothing ran) instead of launching a browser for a process about to exit. The `.lock` file stays behind on purpose: removing it would let two
processes lock two files of one name. A daemon's stderr stays on its CLI's pipe until its socket is bound, so what stops
it starting is said; after that it goes to `~/.agent-browser/logs/daemon-<day>.log`, so a panic in a session can be read. A
daemon whose socket or pid file has gone can't be reached or listed, so the default idle timeout closes it even with a
window open (`idle_daemon_waits`). On Windows a session is ready only at the port its daemon wrote.
## Walks that start together share one identity (`core/src/fingerprint.rs` `asked_elsewhere`, `Asking`)
What a build says about itself is asked once per process, and the mark that it is being asked is process-wide. A page
that finds the mark waits up to 3 s for the answer instead of going out as `HeadlessChrome`. A dropped asking takes its
mark back.
## Stopping a session from the dashboard (`native/stream/dashboard.rs` `kill_session`, `stop_daemon`)
A daemon gets 10 s on SIGTERM to save the session and close its browser; upstream forced it after 500 ms, which lost the autosave and left Chrome running. Only a daemon answering on the session's socket is signalled: a stale pidfile can name any process by now. The session list uses the same test, and cleanup removes everything a daemon writes.
## An MCP timeout says the outcome is unknown (`cli/src/mcp.rs` `append_timeout_message`)
The CLI dies at the timeout, the daemon doesn't, so the message says the command may have taken effect.
`close --all` and `dashboard stop` go by the same proof (`kill_stale_daemon`, `is_dashboard`): a pid file on its own is
never signalled. The dashboard holds a claim named `dashboard`, so no session may have that name.

`close --all` and `dashboard stop` go by the same proof (`kill_stale_daemon`, `is_dashboard`): a pid file on its own is
never signalled. The dashboard holds a claim named `dashboard`, so no session may have that name.

## A capture log counts as settled only once it is (`core/src/capture.rs`)

`<session>.named` says a log needs no second reading, so it is written only after the rewrite that took its passwords
out worked; a failed one is tried again at the next open. The rewrite's copy is this user's alone from its first byte. A
value `forget` is told is secret is replaced however short it is, where it stands on its own. Another handle on the log follows a rewrite to the new file before its next line.

The secrets a daemon's log is naming are kept beside it, sealed with the engine's at-rest key (`AGENT_BROWSER_ENCRYPTION_KEY`
or `~/.agent-browser/.encryption-key`, AES-256-GCM, as saved logins are) in `<session>.secrets`, so a daemon that restarts
in the session reads them back and goes on naming them (`core/src/capture.rs` `Sealer`, `native/auth.rs` `capture_sealer`).
The list is never written in the clear, and `close` wipes it. Before, a reopened log named nothing it had met before the
restart, and a password sent again went into the log as typed. A walk the node runs in process keeps its list in memory.

## Walks that start together share one identity (`core/src/fingerprint.rs` `asked_elsewhere`, `Asking`)

What a build says about itself is asked once per process, and the mark that it is being asked is process-wide. A page
that finds the mark waits up to 3 s for the answer instead of going out as `HeadlessChrome`. A dropped asking takes its
mark back.

## `auth login` says logged in only when the page has stopped asking (`native/actions.rs` `wait_for_login_outcome`, `login_outcome`)

Upstream answered `loggedIn: true` whatever came back. Now a visible password box after the form was sent fails the command, as does a box marked `autocomplete=one-time-code`. That is all a browser can read of a login, so a page that hides its form and asks for a second factor in a box not marked that way still reads as logged in. A form hidden behind a spinner is read twice before it counts as gone, since it comes back when the password was wrong.

## A session restores only its own state (`native/state.rs`, `native/actions.rs` `validate_restore_if_pending`)

Saved state is found by its whole name, `<restore key>-<session id>`, never by prefix: upstream's prefix match gave the key `shop` the cookies saved under `shop-eu`. The cost is that a `--session-name` no longer picks up a file another `--session` saved. A save replaces the file in one rename, so a crash can't leave a session with no state, and a `.previous` from an older crash is still read. An encrypted save removes the plain copy from before the key was set. A restore check waits for a page the session opened: on a blank browser it stays pending, and an `auto` save is skipped as `skipped_restore_unchecked` until it has run.

## A network-idle wait reads only its own page (`native/browser.rs` `poll_network_idle`)

The quiet period is measured from the page's own last event, so another tab's traffic can't hold it off. A closed event stream is an error, not idle. Events lost to a full stream clear what was pending, since the finish of a pending request may be among them. A wait begun after a click still counts the call that click sent: the connection keeps what each page has in flight (`core/src/cdp/client.rs` `RequestsInFlight`), since CDP can't be asked. An `EventSource` and a call open past 10 s don't count: a page keeps those for as long as it lives, and a wait would never end.

## One browser's state is one value (`native/actions.rs` `PerBrowser`, `relaunch_browser`, `auth_challenge_answer`)

What holds only for the open browser (its refs, frames, dialog, routes, origin headers, proxy login, input state, tab parking) lives in `PerBrowser`, and a close replaces it whole, so it can't miss a field. `DaemonState` reads through to it with `Deref`, so upstream's code that uses those fields stays as it is; a line naming `state.per_browser.x` is one where the borrow checker can't see through `Deref` beside another field. A new per-browser field goes on `PerBrowser`.

A browser that dies comes back from the `launch` command it came from, with its proxy, profile and identity; upstream rebuilt it from the environment and the session carried on without them. `close` ends that. A proxy's login is given only to a prompt whose `authChallenge.source` is `Proxy`: upstream gave it to any site that answered 401.

## A saved login's key is never replaced (`native/auth.rs` `find_key`, `place_key_file`)

The key file is made only when no key exists anywhere. A mistyped `AGENT_BROWSER_ENCRYPTION_KEY`, or a damaged or unreadable key file, is an error, where upstream wrote a new key over the good one and left every saved login sealed with a key that was gone. A new key is written owner-only beside the file and linked into place, so it is whole from its first byte and never replaces one another process placed first.
## A walk in someone's browser keeps its tab only for a challenge (`core/src/session.rs` `mint`)
A plain refusal or a page that never answered closes the walk's tab: it shows a person nothing to do.

## A window left open for a person closes when they are through (`core/src/session.rs` `leave_open_for_a_person`, `run_handoff`)

A headed browser left for a person is watched over a connection of its own: once the walked tab reads as the site's
own page, the window is closed through Chrome. Closed by the person, through or not, or past `HANDOFF_TTL`, the
throwaway profile it was opened in is removed with it. What a person finished in a throwaway is never adopted; a window
opened in the remembered profile leaves that profile as the person left it. Before, a person finishing changed nothing:
the window stayed until the timeout and every throwaway folder stayed for good.

## A walk in someone's browser keeps its tab only for a challenge (`core/src/session.rs` `mint`)

A plain refusal or a page that never answered closes the walk's tab: it shows a person nothing to do.

## A dialog belongs to the page it opened on (`native/actions.rs` `pending_dialogs`, `dialog_holds_page`)

A dialog pauses its own page, active or not, so the daemon tracks one per page or frame, not one slot for whatever is active. A paused tab stays reachable, `dialog` answers on the page the dialog holds (the active page's first, else the newest), a command is refused only on the page held, and a dialog goes with its tab. A button a click or a drag left down because a dialog opened mid-way is let go once no dialog holds its page, whoever answered it: the daemon answers alerts itself. `mousedown`, `mouseup`, `mousemove`, `drag` and raw mouse input stop at a dialog and say `dialogOpened`, where upstream's waited out the 30 s DevTools timeout holding the state lock; a button pressed by `mousedown` stays the caller's to release.

The pointer is one for each page, as Chrome has it (`follow_pointer_to_active_page`): a button held on one tab isn't held on another. It records an event only once Chrome took it, and a drag that fails after its press lets go.

## A locator's mark is its own (`native/actions.rs` `located_mark`, `clear_located_mark`)

`nth`, `getbyrole` and the `getby*` locators mark what they find with an attribute and act on what carries it. Upstream's value was always `true`, so a mark left on a page (a click that navigated clears the next page, and the back-forward cache brings the old one back) picked the old element. Each use now has its own value, the mark is set in the selected frame where the action looks, and taking it off waits 500 ms at most: a dialog the action opened gives no answer.

## A ref lives as long as its document (`native/element.rs` `ref_still_in_its_document`, `native/actions.rs` `forget_document`)

A ref carries the loader of the document a snapshot numbered it in, and is refused as stale once another document is loaded, however that happened: a click that navigated, a form sent, a page's own script. Upstream fell back to role and name, so an old `@e3` pressed the next page's same-named control and reported success. The fallback still serves a node re-rendered in the same document. `setcontent` replaces every node under one loader, so it drops the refs itself. A frame selection goes with its document too (`Page.frameNavigated`, `Page.frameDetached`). `back`, `forward` and `reload` wait for the page to get there instead of a fixed pause, and a navigation or new tab that fails leaves the caller's refs and frame alone. Ref numbers carry on across a session's pages rather than restarting at `e1`.

## A Chrome install takes its name when whole (`cli/src/install.rs` `install_tree`)

The tree is built at `.chrome-<version>.partial` and renamed into place, so a killed install doesn't read as installed.
## A HAR recording and the capture log don't take from each other (`native/actions.rs` `har_body_mode`, `handle_har_start`, `handle_har_stop`)
`network har start` and `stop` run beside capture on the same entries. `--content none` is about the recording's file: the capture log still gets every answer's text, and the mode ends with the recording. Starting or stopping a recording leaves the walk the requests still waiting for an answer, and stopping writes what the log hadn't had, each once. With capture on, a `har stop` nobody started is refused rather than emptying the walk's entries. A recording that went over its body budget says how many it left out (`bodiesLeftOut`).

## A HAR recording and the capture log don't take from each other (`native/actions.rs` `har_body_mode`, `handle_har_start`, `handle_har_stop`)

`network har start` and `stop` run beside capture on the same entries. `--content none` is about the recording's file: the capture log still gets every answer's text, and the mode ends with the recording. Starting or stopping a recording leaves the walk the requests still waiting for an answer, and stopping writes what the log hadn't had, each once. With capture on, a `har stop` nobody started is refused rather than emptying the walk's entries. A recording that went over its body budget says how many it left out (`bodiesLeftOut`).

## A plugin can be taken back out (`cli/src/plugins.rs` `remove_plugin_config`)

`plugin remove <name>` takes a plugin out of the project's config, or `--global`'s. Upstream had no way but editing the JSON by hand.

## A plugin runs the version it was added at (`cli/src/plugins.rs` `pin_plugin_source`)

`plugin add` asks npm which version the reference names now (`npm view`, the newest a range meets) and writes
`npx -y <name>@<x.y.z>` into the config, so the package run later is the one whose manifest gave the capabilities. A
GitHub repository is added only at a full 40-character commit (`owner/repo#<commit>`), since npm has no lookup for one.
Upstream wrote `npx -y <name>`, which fetched whatever npm held at each run.

## A yes is for the command it was asked about (`native/actions.rs` `PendingConfirmation`, `native/policy.rs`)

The daemon makes each confirmation's id (`c_<hex>`) and `confirm` and `deny` must name it, so an approval can't reach a later
command that took the slot. A question lasts 60 s, as the help says. `confirm` and `deny` are checked with
`ActionPolicy::check_answer`: an allow list can't strand a question, only a `deny` naming them refuses them. A policy file that
stops reading or parsing denies everything until it is mended, instead of leaving the old policy in force.

## Long scripts, and a client that outlasts the daemon's own timeout

- `eval --timeout <ms> <script>` gives a script up to `<ms>` (at most 300000) instead of the DevTools default of 30 s
  (`core/src/cdp/client.rs` `COMMAND_TIMEOUT`, `send_command_within`; `BrowserManager::evaluate_within`). One that runs
  past it is answered as such ("the script didn't finish within N s…"), while the CLI still listens.
- The CLI's read timeout floor is the DevTools timeout plus 10 s (`core/src/connection.rs` `read_timeout_for`), not
  30 s. At 30 s the client gave up at the same moment the daemon did, and a 30 s script surfaced as
  "Failed to read: Resource temporarily unavailable (os error 35)", EAGAIN from the socket read on macOS.
- A read that runs out of time says so (`connection.rs` `read_failed`): "the browser gave no answer within N s: it is
  still busy with this command or one ahead of it, or the page has hung". It is not retried.

## What ends with a session (`cli/src/main.rs` `nothing_to_close`, `send_command_with_respawn`, `native/daemon.rs`)

`close` with no daemon and no holder answers without starting one. The saved CA choice goes after a close that happened,
not before the close is sent.

## A close returns once the daemon is gone (`main.rs` `send_command_with_respawn`, `connection.rs` `wait_for_daemon_exit`)

Upstream's daemon answers `close` and then exits. In that gap its socket still takes a connection and drops it, so the
next command (an `open` right after the close) failed with "Invalid response: EOF … it may or may not have run, so it
was not retried", and the daemon's exit then removes the socket and pid file a new daemon would have made. `close`, and
the graceful shutdown before a restart, now wait up to 5 s until the socket refuses, the `.pid` file is gone and the
process has exited.

## `diff snapshot` compares with something (`cli/src/native/actions.rs`)

Upstream's help promises the last snapshot, but it kept none: with no `--baseline` it compared with nothing and every line read as added, and a mistyped `--baseline` was taken as the text to compare. The daemon now keeps each page session's last snapshot (`last_snapshots`, bounded at 32, a diff counting as one) and what it was taken with. A diff naming no options is taken the same way; one that can't be compared, or has nothing to compare with, is refused. A named baseline is a file that must exist, read through `file_root`, as `diff screenshot --baseline` is.
## An install is done when the binary runs (`scripts/postinstall.js`)
Upstream's postinstall read a file being there as done. A refused download left an empty file, a cut one left part of
one, and the next install called either ready. It also repointed the global command at the binary after a failed
download, and into a project's `node_modules` on any project install. Now a binary is ready when `--version` runs. A
download is written beside it and moved into place only once all of it arrived and it runs, and the global command is
touched only by the global package, after a download that worked. The binary comes from this repository's release
of the package's version (`agent-browser-<platform>`, which the Release workflow attaches), never upstream's, and is kept
only when its SHA-256 is the one that release's `SHA256SUMS` lists. A release that lists none for the machine, or whose
list can't be fetched, is skipped with a message and the binary is never asked for: an unchecked download is never
installed. Upstream's releases publish no checksums.
## The chat's right to a session ends with that session's daemon (`native/stream/chat.rs` `chat_grant`)
A session the chat started stays the chat's only while it is that same daemon: a grant holds the daemon's pid, so the owner's later daemon under the same name is out of reach. A call the chat's timeout gives up on is killed, and an answer the gateway cut off is said to be, with any half-written tool call dropped.

## A command's files stay inside one root (`cli/src/native/file_root.rs`)

A daemon command may come from an agent, so the files it names are confined to one declared root: `AGENT_BROWSER_FILE_ROOT`, or `~/.agent-browser/files` when unset. That covers the paths `screenshot` (and `--screenshot-dir`), `pdf`, `network har stop` and `diff screenshot --output` write, and the files `upload`, `diff screenshot --baseline` and `diff snapshot --baseline` read. A relative path is taken from the working directory when that is inside the root, else from the root. Anything that resolves outside it, through `..` or a symlink, is refused. Writes never follow a symlink at the file itself, and a timestamped default name is created exclusively. `AGENT_BROWSER_FILE_ROOT=/` is the owner's opt-in to upstream's any-path behaviour.

## `dashboard start` waits for the dashboard (`cli/src/main.rs` `wait_for_dashboard`)

It says started only once the dashboard is listening, and clears its files if it never does.

## The browser's debugger answers only its launcher (`core/src/cdp/pipe.rs`)

A launched Chrome gets `--remote-debugging-pipe` and opens no debugging port: Chrome has no authentication on a port, and checks a WebSocket's Origin only when one is sent, so any local process of any OS user could read every cookie of a signed-in profile and run script in it. Chrome reads commands on fd 3 and answers on fd 4 (on Windows, the C runtime's inherited handles), which only the launching process holds. A `--remote-debugging-port` in `--args` is dropped.

The launcher serves the pipe to its other clients (the daemon's own connection, the node's walk and picture) through a relay in the same process: it listens on loopback but answers a WebSocket only at `/devtools/browser/<secret>`, a 256-bit secret drawn at launch and compared in constant time, refuses any request that names an Origin (a web page), and serves nothing else, no `/json` listing and no frontend. Each client gets its own browser session (`Target.attachToBrowserTarget`), so its ids, events and sessions are its own and it can't drive or detach another's. The secret goes only to the launcher's callers and into `DevToolsActivePort`, written 0600 (the runtime dir is 0700).

Measured on Chrome 155: a browser driven over a pipe tells pages `navigator.webdriver` is true, as one on an ephemeral port does, so the launch also passes `--disable-blink-features=AutomationControlled` (merged with any the caller gives); the browser's other switches are unchanged, and the node passed the same switch already. `inspect` on a launched browser opens DevTools as a tab of that browser, from the copy it carries (`devtools://`), since there is no HTTP server to serve it from; on a browser attached with `--cdp` it opens as before.

The cost: Chrome closes when its pipe does, so a browser lives as long as the process that launched it. The reattach below still finds a live launcher's browser, but a daemon that crashes or is killed takes its browser with it. A launcher that leaves on purpose (`close`, the idle timeout, SIGINT/SIGTERM/SIGHUP) while another daemon still holds a place on its runtime Chrome doesn't close it under that daemon: it removes its socket and files, so a new command starts a new daemon (which reattaches), and the process stays, serving the browser, until the last other daemon has gone; then it closes the browser as anyone last out would (`ChromeProcess::serve_while_others_remain`, `serve_kept_browsers`). The launcher stays the owner; the others only detach. A second signal ends it at once. Clients that hold no place (a node's walk or picture) are not counted.

## A daemon takes commands only from its owner (`cli/src/owner_only.rs`)

On Unix the daemon's door is a socket made 0600 in a socket folder the daemon narrows to 0700. On Windows the door is a loopback port anyone on the machine can reach, so the daemon writes a 256-bit key to `<session>.key` beside its `.port` file (a protected DACL naming only the current user) and refuses, and hangs up on, any command that doesn't carry it as `doorKey`, compared in constant time and taken off before the command runs. The CLI and the node add it. The capture logs, which hold the traffic of signed-in sessions, are 0600 in a folder narrowed to 0700.

## Fixed runtime dir and daemon-crash reattach

Since the debugger moved to a pipe (above), a Chrome closes with the process that launched it, so what follows holds only while that process lives.

A no-profile Chrome launch uses a fixed runtime dir, `~/.agent-browser/chrome-runtime-{headless,headed}`, instead of a random temp dir (`AGENT_BROWSER_RUNTIME_DIR` overrides). When a daemon dies without cleanup — a crash, exactly what orphaned the SISTIC purchase sessions to a manufactured `about:blank` — the Chrome it launched survives with its pages, cookies and capture, and the next daemon reattaches through the `DevToolsActivePort` file that lives in the runtime dir, instead of launching a fresh Chrome and manufacturing a blank page. A deliberate `close --all` still shuts the browser down.

Consequences worth knowing:
- the runtime Chrome outlives a daemon that crashes, and a `close` or the idle timer ends it from whichever daemon is using it, the one that launched it or one that reattached (`BrowserProcess::Reattached`). A reattached Chrome that answers `Browser.close` and stays is killed; one that doesn't answer is left, since its pid proves nothing by then;
- several daemons can use the runtime Chrome at once. Each holds a shared lock on `agent-browser-chrome.holders` in the runtime dir (`BrowserHold`), and the last one out closes it, holding the lock alone until it has gone. A crash lets go of the lock, so nobody has to clear a list of who is attached;
- launch flags apply when the runtime Chrome first starts — a later daemon reusing it inherits those flags (isolate with `AGENT_BROWSER_RUNTIME_DIR`);
- a browser a daemon launched in a profile given by path comes back the same way: the daemon records it (`remember_chrome`, with its mode, since a profile holds either) and the next daemon reattaches, shares and closes it like a runtime Chrome, inheriting its launch flags. A walk's browser, or a person's, has no record and is left alone. A profile given by name is a temp copy and is not found again;
- a launch accepts `DevToolsActivePort` only at the port it gave its browser: anywhere else the file is another launch's;
- the launch records the runtime Chrome's process id in the runtime dir (`agent-browser-chrome.pid`, owner-only). A later daemon reattaches only while that process is alive and the endpoint names it as its browser (`SystemInfo.getProcessInfo`), so a stale `DevToolsActivePort` never hands the session to another process that took the port. A runtime Chrome started before this record existed is not reattached; `close --all` once clears it.

## A trace keeps every event (`native/tracing.rs`)

`trace stop` and `profiler stop` read Chrome's events through `subscribe_methods`, which loses nothing, not the broadcast. Upstream's reader read falling behind as the trace being over, and saved what it had as a whole trace. A browser that goes away mid-stop is now an error, with nothing saved.

## Upstream tests that fail by design

These 16 tests exercise refused features. Each fails because the policy refuses the feature first.

- `native::browser::tests::test_obscura_rejects_unsupported_options_before_spawn`
- `native::e2e_tests::e2e_obscura_auto_launch_can_open_page`
- `native::e2e_tests::test_obscura_e2e_unlaunchable_binary_does_not_attach_to_inherited_cdp`
- `native::e2e_tests::test_obscura_launch_uses_request_proxy_bypass`
- `tests/obscura_cli.rs`: all four `obscura_existing_daemon_*` tests
- `native::providers::tests::test_connect_provider_unknown`
- `native::providers::tests::test_connect_provider_with_supplied_registry_does_not_fallback_to_env_plugins`
- `native::providers::tests::test_plugin_provider_falsey_headed_env_is_false`
- `native::providers::tests::test_plugin_provider_receives_command_launch_options`
- `native::actions::tests::test_allowed_domains_reject_direct_page_provider_plugins`
- `native::actions::tests::test_allowed_domains_reject_plugin_profile_args`
- `native::actions::tests::test_browser_use_canceled_setup_and_stop_preserve_state`
- `plugins::tests::launch_mutator_plugin_returns_launch_changes`

Everything else passes: 1,459 passed and 150 ignored (most need a live browser).

## Licences

agent-browser is Apache-2.0. Lightpanda is AGPL-3.0: ship its unmodified binary as a separate process with its licence and source offer, and never link it into the node.

## A walk reads everything the browser said, and ends when it goes (`core/src/cdp/client.rs` `Relay`, `core/src/session.rs` `walk_tab`)

Upstream's raw broadcast keeps 4096 messages and drops the oldest, and never closes while the client lives. A walk reads
through `CdpClient::relay()`, which keeps what the browser said until it is read and ends when the line closes.

An anti-forgery token a page sends is kept for the session whether the walk keeps a log or not (`note_header_tokens`).

## A walk that asked for interception never goes without it (`core/src/session.rs` `walk_tab`)

With `intercept` set, every request is checked to resolve to a public address and pinned there (`core/src/intercept.rs`).
A browser that refused `Fetch.enable` used to get a line on stderr while the walk went on over its own connections. The
walk now ends before the page is opened, and says why.

## A left copy of a Chrome profile goes at the next copy (`core/src/cdp/chrome.rs` `sweep_left_copies`)

Copies are named with their maker's pid, and one whose maker is gone and that no browser holds is removed.
