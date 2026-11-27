# Install and run

How to get the node onto a machine, what it needs there, how each platform differs, and how to run it. The download
links and the from-source build are in the root [README](../../README.md#install); this page adds what they leave out.
Every command is in [CLI.md](../CLI.md).

- [1. Ways to install](#1-ways-to-install)
- [2. What the node needs](#2-what-the-node-needs)
- [3. Platforms](#3-platforms)
- [4. Running the node](#4-running-the-node)
- [5. Which chain it runs on](#5-which-chain-it-runs-on)

---

## 1. Ways to install

Each release ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)) builds the same four programs for
every machine: `unbrowse-node` (the node), `unb` (its shell client), `agent-browser` (the browser program it drives pages
with) and `unbrowse-window` (the window). They look for each other beside themselves, so they stay in one folder. The
browser program is an add-on: npm and the wheels leave it out, and the node fetches it, with Chrome for Testing when
there's no Chromium, the first time a goal needs a browser ([the-browser.md](../guides/the-browser.md)).

| Way | What you get | The agent skill | The `unbrowse` command |
|---|---|---|---|
| `npm install -g unbrowse` | the node, `unb` and the window for this machine, as the optional dependency `@unbrowse/<platform>-<arch>`, plus the client and the skill; no browser | put in `~/.claude/skills/unbrowse` when `~/.claude` exists (`cli.ts` `postinstall`) | yes |
| The release's wheel, `unbrowse-<v>-py3-none-<machine>.whl` | the same, for Python | not placed: run `unbrowse skill` | yes |
| `unbrowse-<v>-py3-none-any.whl` | the Python client alone, for any other machine | not placed | yes, but it finds no programs |
| The Mac disk image or `Unbrowse-<v>-macos-<arch>.zip` | `Unbrowse.app`: the window, with the node and `unb` in `Contents/MacOS`; the browser comes when a goal needs it | put in the skills folder of every agent found on this machine, from the copy the app carries: on the first start after the terms are accepted, and again when a newer version carries a different skill | yes: `unb`, `unbrowse-node` and `unbrowse` in `~/.local/bin`, from the same start |
| `unbrowse-<v>-<os>-<arch>.tar.gz` or `.zip` | the four programs in a folder, with a README (`.github/scripts/package-programs.sh`) | the same, on the node's first start after the terms are accepted | the same |

The wheels are attached to the GitHub release; nothing is published to PyPI ([OPERATIONS.md §10](../OPERATIONS.md#10-known-gaps)).
npm still serves an older `unbrowse` today; until the current releases reach it, install from the release page
([TROUBLESHOOTING.md](../TROUBLESHOOTING.md#npm-install--g-unbrowse-installs-an-old-version)).

`unbrowse where` prints where the command found the programs: `UNBROWSE_BIN`, else inside `Unbrowse.app` (the
package's, `/Applications` or `~/Applications`), else the platform package's `bin`, else "on PATH" (`cli.ts` `binDir`,
`cli.py` `bin_dir`). `UNBROWSE_APP` names an app bundle to use; both CLIs run it only when its signature names the
vendor's team, and `UNBROWSE_UNCHECKED_APP=<absolute path>` runs a build of one's own with signature checks off,
warning on every run.

`unbrowse skill [dir]` copies the skill the package carries into `dir`, by default every agent's skills folder found
here, replacing what was there ([the-skill.md](../reference/the-skill.md)).

**The Mac app and the archives put both halves in place themselves**, since dragging a disk image in runs no code of its
own (`unbrowse-node/app/src/install.rs`): once the terms are accepted, the node writes the skill into the skills folder
of every agent found on this machine, links `unb`, `unbrowse-node` and `unbrowse` into `~/.local/bin`, and — when the
shell's own file doesn't name `~/.local/bin` already — adds one guarded line to the file that shell reads at login
(`~/.zprofile` for zsh, `~/.bash_profile` for bash, `~/.config/fish/config.fish` for fish, `~/.profile` otherwise).
Anything already at the skill's name that Unbrowse didn't write is kept beside it, never deleted. `unbrowse install
--dry-run` says what it would do, `--skill` or `--commands` does one half, and the same step is in the app's setup list
(`unbrowse_setup`, `do: "tools"`). A program running from a mounted disk image or a translocated copy puts no commands
on the PATH — the links would break when the image went away — and says to open the app from Applications first.
Windows keeps the commands in the installer's own folder: nothing adds it to the user PATH yet.

**macOS signing:** Production releases are signed with Unbrowse's Developer ID and notarized by Apple, so the app opens normally. Unsigned local or dev builds are blocked by Gatekeeper on first launch; open via right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Unbrowse.app`.

---

## 2. What the node needs

| Need | Why | Without it |
|---|---|---|
| A Chromium browser, and the browser program | only to learn a page or browse one: the node walks and browses in a Chromium (`app/src/browsers.rs`): the one chosen in Settings, else the Chrome for Testing it downloaded, else Chrome, else any other Chromium browser installed | search, calls and the owner's commands work; a goal that needs the browser fetches it first (`fetch_browser`) or answers `browser_missing` ([the-browser.md](../guides/the-browser.md)) |
| Foundry's Anvil at `~/.foundry/bin/anvil` | only for test mode: the local devnet, which a build from source runs on by default, is an Anvil the node starts (`chain.rs` `start_devnet`) | the node says "Anvil isn't installed (~/.foundry/bin/anvil); run foundryup"; a release runs on Arc testnet and doesn't need it |
| GTK 4, or 3 | the window, on Linux | the node runs; only the window doesn't open ([TROUBLESHOOTING.md](../TROUBLESHOOTING.md#the-window-doesnt-open-linux)) |

A browser counts as Chromium by what the program is, never by a list of names: it opens web links and carries
Chromium. Safari and Firefox open links but carry no Chromium, so the node can't drive them the way it records
(`browsers.rs`). Chrome, Brave, Edge, Arc and Vivaldi all qualify.

---

## 3. Platforms

| Machine | Release | Window |
|---|---|---|
| macOS, Apple silicon and Intel | npm, wheel, disk image, zip, `.tar.gz` without the window | native |
| Linux x64 and arm64, glibc 2.35 or later | npm, wheel, `.tar.gz` | native (GTK) |
| Windows x64 | npm, wheel, `.zip` | native |

The node is the same everywhere. What differs underneath:

| Seam | macOS | Linux | Windows |
|---|---|---|---|
| The root key (`crates/core`) | the Keychain | the Secret Service; `~/.unbrowse/root.key` (readable by its user alone) when there is no desktop session or the keyring can't round-trip a secret ([ARCHITECTURE.md §6](../ARCHITECTURE.md#6-keys-and-the-vault)) | the Credential Manager |
| Finding browsers (`browsers.rs`) | an app bundle with Chromium's renderer helper | a desktop entry for web links whose program sits beside Chromium's resource pack | a program Windows lists as a web browser, with that pack beside it |
| The browser CLI's daemon, for the node's interactive `browse` path (`unbrowse-browser/cli/src/connection.rs`) | a Unix socket | a Unix socket | a loopback TCP port |
| The window (`unbrowse-node/window/src/main.zig`) | native, or `--web` | native | native |

On a Mac over SSH the login Keychain is locked: `security unlock-keychain` first.

---

## 4. Running the node

```sh
unbrowse app      # open the window; it starts the node when none answers
unbrowse start    # run the node alone, in the foreground (unbrowse-node)
```

The window talks to the node over `127.0.0.1` with the owner's token, and closing it leaves the node running for
agents ([the-app.md](the-app.md)). Its first-run screen shows the terms and offers keeping the node off the network; the
node doesn't join until that is answered. On a machine no one opens the window on, `unbrowse start` is the
node: it serves agents at once and stays off the network, saying why, until you run `unbrowse terms show` and
`unbrowse terms accept`. Its own commands (`unbrowse agent new`, `vault`, `session`, `wallet restore` and the rest) run from a shell
([CLI.md §2](../CLI.md#2-unbrowse-node-commands)). To keep it running, make it a service
([OPERATIONS.md §7](../OPERATIONS.md#7-running-a-node-as-a-service)). Run your agents as their own OS user, never as
yourself: `unbrowse-node agent-user install`, then `unbrowse-node agent-user run -- <agent>`
([agents-os-user.md](../guides/agents-os-user.md)).

- **Where it listens.** `127.0.0.1:7788`, the `api_port` setting; a new port takes effect at the next start
  ([node-settings.md](../reference/node-settings.md)).
- **Where it keeps things.** `~/.unbrowse`, or `UNBROWSE_HOME` (`store::home`).
- **What happens at start**, in order: [ARCHITECTURE.md §5](../ARCHITECTURE.md#5-runtime-agent-node-site-window).
- **Pausing.** A paused node answers agents with HTTP 503, "the node is paused by its owner" (`api/goal.rs` `do_goal`,
  `api/call.rs` `do_call`; `browse.rs`), and lists nothing by itself (`share.rs`). Pause and resume it in Settings.
- **Restarting.** `unbrowse restart` restarts the running node once no call is under way ([CLI.md §2](../CLI.md)).
- **Staying current.** A release build updates itself; a build from source never does ([updates.md](../guides/updates.md)).

---

## 5. Which chain it runs on

A release runs on Arc testnet. A fresh install runs on the network its build names (`UNBROWSE_DEFAULT_CHAIN`,
`app/src/build_config.rs` `default_chain`); a release names Arc testnet, and a build from source names none, so it
runs on the local **devnet**, which the app shows as **Test mode**: an Anvil on `127.0.0.1:8546` with its state in
`~/.unbrowse/devnet`, which forks Arc testnet and on which the node sets up its own test money and contracts.

Payments aren't open on Arc testnet yet: neither Arc network file (`unbrowse-node/app/networks/arc-testnet.json`,
`arc-mainnet.json`) names a deployment, so a node there learns and calls routes and joins the peer network, and the
app says "Payments aren't open on this network yet"
([TROUBLESHOOTING.md](../TROUBLESHOOTING.md#settlement-isnt-deployed-on-arc-testnet-yet)). `unbrowse-node chain <name>`
moves a node. What things cost: [MONEY.md](../MONEY.md); the first steps of a new owner: [ONBOARDING.md](../ONBOARDING.md).

Next: [Your first call](your-first-call.md).
