# Mac install with no terminal: design

Status: design (hub programme 3c65e2, step 2, 2026-11-21). Nothing here is built yet.

**Conversion gap.** A Mac user who arrives from the landing page and uses Claude Desktop, Claude Code, Cursor or Codex
has to install Node, run `npm install -g unbrowse`, then paste `claude mcp add …` before their agent makes its first
call. This design takes them from the downloaded disk image to a working local MCP server in their agent with clicks
only.

**KPI.** Share of Mac downloads whose node serves a first MCP `tools/call` within 24 h (UNB-179 funnel). Baseline
UNMEASURED; target set once the baseline is read.

## What already exists (origin/staging bead4657)

- Every release already ships `Unbrowse-<ver>-macos-{arm64,x64}.dmg`, plus version-less copies at
  `releases/latest/download/Unbrowse-macos-<arch>.dmg` (`.github/workflows/release.yml:757`). The latest release,
  v13.18.1 (2026-11-06), has them.
- `.github/scripts/package-macos.sh` builds the DMG with `hdiutil` (UDZO, HFS+, the app beside an `/Applications`
  link). It signs with `codesign` (a Developer ID when `MACOS_SIGN_IDENTITY` is set, otherwise ad hoc), and it
  notarizes and staples with `notarytool` / `stapler` with an App Store Connect team key (`APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), a keychain profile (`NOTARY_PROFILE`), or `APPLE_ID`, `APPLE_TEAM_ID` and
  `APPLE_APP_PASSWORD`, the first that is set. A submission Apple doesn't accept fails the build with its log.
- `Unbrowse.app/Contents/MacOS` holds `unbrowse-window`, `unbrowse-node` and `unb` (`package-macos.sh:33`). The
  window starts the node from beside itself, detached, and the node outlives the window (`window/src/api.zig:242`).
- `unb connect` (`app/src/bin/unb.rs:669`, `bin/unb/migrate.rs`) registers the node with **Claude Code only**, through
  the `claude` CLI, as a stdio entry `<abs unb> mcp --agent first` with `UNBROWSE_NODE`. It checks the entry with
  `initialize` and `tools/list`, backs up and replaces older entries, and can undo. Cursor and Codex entries are only
  read and reported (`legacy.rs:122`, `legacy.rs:317`). Claude Desktop isn't handled.
- `unb mcp` reads the agent's token from the owner's grant (`~/.unbrowse/bridges/agent-<n>.token`, written by
  `agents::write_grant`, `agents.rs:592`). No token goes in any client config (`scripts/connect-e2e.sh:117`).

## What stops "no terminal step" today

1. **Gatekeeper.** No release is notarized. The repo has `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD` and
   `APPLE_TEAM_ID` (added 2026-11-18), but not `APPLE_ID` or `APPLE_APP_PASSWORD`, and the `MACOS_NOTARIZED`
   variable isn't set. On macOS 15 a non-notarized download can't be opened until the owner goes to System Settings ›
   Privacy & Security › Open Anyway. The release notes offer `xattr -dr …` as the alternative.
2. **No client registration from the app.** The window's Access screen shows a `claude mcp add …` line to copy
   (`window/src/screens/access.zig:40`). It has no button, and no client gets registered.
3. **No onboarding step for agents.** `first_run.zig` is one screen: terms, a network checkbox, and "Open my node".
4. **The MCP server dies with the node.** After a reboot, nothing starts the node until the window is opened. `unb mcp`
   doesn't start it (only `unb connect` does, `unb.rs:721`), so the agent's server fails.
5. **App run from the disk image.** If the owner opens the app inside `/Volumes/Unbrowse` or a translocated path, any
   absolute `unb` path written into a client config breaks once the image is ejected.

## Design

### Packaging tool: unchanged

The packaging stays `hdiutil` + `codesign` + `notarytool` + `stapler` in `package-macos.sh`.

There is no `.pkg`, no `create-dmg`, and no new tool. A `.pkg` postinstall script runs as root, outside the owner's
login session and keychain, so it can't write the owner's grant or see their client configs. The app's first launch
runs as the owner and can do everything a postinstall would.

The one packaging change makes notarization a hard requirement. A `production` release fails unless all three notary
secrets are set, and it sets `MAC_TRUST` from the stapled ticket (`stapler validate`), not from a variable a person
has to remember. Preview and staging builds may still be signed ad hoc.

### Install flow the owner sees

1. Download `Unbrowse-macos-<arch>.dmg` and drag Unbrowse onto Applications. Because the image is notarized and
   stapled, it opens like any app.
2. On first open, the window checks where it runs. If `exe_dir` starts with `/Volumes/` or contains
   `/AppTranslocation/`, it shows one screen with one button, "Move to Applications". That button copies the bundle
   with `ditto` to `/Applications/Unbrowse.app` (or to `~/Applications` if that isn't writable), opens the copy, and
   quits. Registration never runs from an unstable path.
3. Terms screen (exists). The window already starts the node (exists).
4. **New: "Connect your agents" screen.** It lists the clients found on the Mac, each with a checkbox that is ticked
   by default. One button, **Connect**, connects them. Each row then shows its result: Connected, Quit and reopen
   Claude, or the error in plain words. Step 4 of the programme adds the remote MCP URL row to this same screen.
5. The agent's next session has the `unbrowse` server. The node is started on demand (below), so it survives a
   reboot without the window.

### MCP registration method

Registration is a stdio entry written into each client's own config. It is never an HTTP URL with a bearer, because
`/mcp` refuses plain bearers by default and `access.zig:52` forbids handing one out. The same entry goes everywhere:

```json
{ "command": "/Applications/Unbrowse.app/Contents/MacOS/unb",
  "args": ["mcp", "--agent", "first"],
  "env": { "UNBROWSE_NODE": "http://127.0.0.1:7788" } }
```

The command is the absolute `unb` beside the running node (`agents::unb_program`, `agents.rs:248`). The port is the
node's real port.

| Client | Found when | Written to | How |
|---|---|---|---|
| Claude Code | `~/.claude.json` or `~/.claude/` exists | user scope `mcpServers.unbrowse` | `claude mcp add --scope user …` when a `claude` binary is found (`UNBROWSE_CLAUDE`, then `PATH`, then `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, because a GUI app's PATH is only `/usr/bin:/bin:/usr/sbin:/sbin`). With no binary, a JSON merge into `~/.claude.json`. |
| Claude Desktop | `~/Library/Application Support/Claude/` exists | `claude_desktop_config.json` `mcpServers.unbrowse` | JSON merge. The row says "Quit and reopen Claude". |
| Cursor | `~/.cursor/` exists | `~/.cursor/mcp.json` `mcpServers.unbrowse` | JSON merge |
| Codex | `$CODEX_HOME` or `~/.codex/` exists | `config.toml` `[mcp_servers.unbrowse]` | The replace logic of `integrations/codex/install.sh`, ported to Rust. It touches only that table and keeps every other line. |

Rules for every writer, all of which `unb connect` already holds for Claude Code:

- Back up the file as `<file>.before-unbrowse-<time>` (0600) before the first change, and keep the original's mode.
- Replace an older Unbrowse entry (12.x `npx unbrowse mcp`, a hosted unbrowse.ai URL) using the existing `legacy.rs`
  detectors. Leave any other server, and any `unbrowse` entry no Unbrowse install wrote, alone, and report it.
- No token in any file, argument or log line.
- Verify each entry after writing by spawning its command with `initialize` + `tools/list` and expecting the node's
  tools. A failed verify restores the backup.
- Undo restores every file connect changed.

**Grant.** The owner's click on Connect is the yes. The route makes sure the first key exists (`agents::ensure_first`)
and writes its grant with `agents::write_grant(index, token_of(index), true)`, so `unb mcp --agent first` works with
no keychain prompt in the agent's process.

**Node on demand.** `unb mcp` starts the node when nothing answers at `UNBROWSE_NODE`. It reuses `start_node`
(`unb.rs:910`), the same detached start `unb connect` uses, then waits up to 15 s for `/v1/node/proof`. This means a
client opened after a reboot works without the window. There is no LaunchAgent and no login item in this programme;
add one only if peer-network uptime needs the node running when no agent is.

### Routes (window → node, owner token, like the window's other calls, `api.zig:78`)

- `GET /v1/node/clients` returns `[{id, name, found, connected, path}]`.
- `POST /v1/node/connect {clients:[id…]}` returns `[{id, ok, restart_needed, error?}]`.
- `POST /v1/node/connect/undo` returns the files it restored.

## Files to add or change

| File | Change |
|---|---|
| `unbrowse-node/app/src/connect.rs` (new) | Client registry, detection, entry building, backup/undo, verify. It is moved out of `bin/unb.rs:669` `connect()` and `bin/unb/migrate.rs`. It uses only std and serde, no node module, because the crate has no lib: both binaries include it, the same way `unb.rs:61` takes in `signed_client.rs`. |
| `unbrowse-node/app/src/connect/{claude_code,claude_desktop,cursor,codex}.rs` (new) | One writer per client, as in the table above |
| `unbrowse-node/app/src/main.rs` | `mod connect;` |
| `unbrowse-node/app/src/bin/unb.rs` | `#[path = "../connect.rs"] mod connect;`. `connect()` calls `connect::run`. New `--client claude-code\|claude-desktop\|cursor\|codex\|all` flag, default `all` found. `unb mcp` starts the node on demand (`start_node`). Header usage text updated. |
| `unbrowse-node/app/src/bin/unb/migrate.rs`, `legacy.rs` | Keep the legacy detectors, and move the Claude Code write into `connect/claude_code.rs` |
| `unbrowse-node/app/src/api.rs` (+ `api/connect.rs` new) | The three owner routes above |
| `unbrowse-node/app/src/agents.rs` | No change expected (`ensure_first`, `token_of`, `write_grant` reused). `setup_for()` text points at the window's Connect button. |
| `unbrowse-node/window/src/screens/connect.zig` (new) | The "Connect your agents" screen: client rows, the Connect button, per-row results, an anchor for step 4's remote row |
| `unbrowse-node/window/src/screens/move_to_apps.zig` (new) | The "Move to Applications" screen and the `ditto` + reopen |
| `unbrowse-node/window/src/shell.zig` | Routing: move screen when the path is unstable, then terms (`first_run`), then connect while no client is connected and the screen hasn't been dismissed |
| `unbrowse-node/window/src/screens/first_run.zig` | "Open my node" goes on to Connect instead of Home |
| `unbrowse-node/window/src/screens/access.zig` | The copy-paste `claude mcp add` example is replaced by the same client list, with a Connect/Undo button. "Copy example requests" stays for other clients. |
| `unbrowse-node/window/src/api.zig` | Calls for `clients`, `connect` and `undo` |
| `.github/scripts/package-macos.sh` | A `production` release fails if it isn't notarized. Add `stapler validate` on the DMG and the app. |
| `.github/workflows/release.yml` | `MAC_TRUST` comes from the stapled ticket, not `vars.MACOS_NOTARIZED`. The Mac line in the release notes no longer mentions `xattr`. |
| `.github/workflows/ci.yml` (macOS job) | The Mac install end-to-end test below |
| `unbrowse-node/scripts/connect-e2e.sh` | Covers all four clients with a fake `$HOME`, the routes, undo, no token in any file, and starting the node on demand |
| `README.md` (Install), `docs/ONBOARDING.md` §1, `docs/guides/connect-your-agent.md`, `docs/CLI.md`, `LOCAL-USE.md` | Mac: the DMG first and the window's Connect button. CLI: `unb connect --client`, and `unb mcp` starts the node. |

## Tests (three kinds, per the release-train rule)

- **Unit.** `connect/*` writers against a fake `$HOME`. They must merge without touching other servers, replace
  legacy entries, take a backup and undo exactly, keep the file mode, never write a token, and handle a missing or
  malformed config (left untouched, error reported). Codex TOML cases are taken from `integrations/codex` CI.
- **End to end.** `scripts/connect-e2e.sh` extended, plus a macOS job that mounts the built DMG (`hdiutil attach`),
  `ditto`s the app into a temp Applications folder, starts its node, calls `POST /v1/node/connect` for all four
  clients under a fake `$HOME`, spawns the command written in each config, and expects `tools/list` to answer.
  Marker: `MAC_INSTALL_E2E_OK`. The same job kills the node and expects `unb mcp` to bring it back.
- **Simulated person.** The GUI clicks are the piece CI can't do. Waiver for CI: a once-per-release manual check on the
  self-hosted Mac runner (`vars.MAC_RUNNER`, `lewis-mbp`): download → drag → open → Connect → Claude Desktop answers
  one Unbrowse tool. Programme step 5 runs it.

## Out of scope

`.pkg` installers, a Homebrew cask, a LaunchAgent / login item, Windows and Linux installers, and changes to the
update channel (`updates.yml`).

## Open, owner's to answer

- **Notarization needs an App Store Connect team key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) in the
  repo's release secrets** (or `APPLE_ID` with an app-specific `APPLE_APP_PASSWORD`). Without
  them, step 1 of the install flow still needs System Settings › Open Anyway, and the goal's "no terminal step"
  holds but "opens like any app" doesn't. This is needed before step 6 (release), not before steps 3–5.
- The UNB-152 keychain prompts on first launch (one per secret per build) add prompts to this flow until that
  ticket lands.
