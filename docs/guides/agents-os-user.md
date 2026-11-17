# Agents as an OS user of their own

Run your agents (Claude Code, Codex, OpenClaw, a script) as a separate OS user, `unbrowse-agent`, never as yourself.
The node keeps running as you.

- [Why](#why)
- [Install](#install)
- [Run an agent](#run-an-agent)
- [Check it](#check-it)
- [Existing installs: the migration](#existing-installs-the-migration)
- [Remove](#remove)
- [What it does on each OS](#what-it-does-on-each-os)
- [What it doesn't close](#what-it-doesnt-close)

## Why

An agent that runs as you can read everything your user can. That includes:

- `~/.unbrowse/owner.token`, which runs every owner command;
- a file-kept `root.key` (Linux with no keyring), which is the node's wallet;
- the owner passphrase's hash, which it can try to guess offline;
- the Linux Secret Service and Windows Credential Manager, which hand any item to any program of the same user;
- your X11 session, where it can press the button in the node's dialog.

The node asks for your yes before it hands out a secret ([SECURITY.md](../../SECURITY.md#the-owners-yes)), but a
program running as you can get around some of that. Run as another OS user, an agent can read none of these:

- the node's folder is yours alone (0700, everything in it without group or other bits);
- keystores and desktop sessions are per user;
- one user's programs can't trace or read another's.

The agent still reaches the node the way every agent does, over `127.0.0.1` with its own agent key's token.

## Install

Run this as yourself, the owner, not as root. It asks for your password (`sudo`) to make the user. On Windows, run it
in an Administrator PowerShell.

```sh
unbrowse-node agent-user install
```

It shows each step and asks before doing anything (`--yes` skips the question). It:

1. Makes your node's folder, and everything directly in it, yours alone. The node does this on every start too.
2. Makes a new agent key, `agents (OS user unbrowse-agent)`, with the default cap. `--agent <index>` uses a key you have
   already, unless its token is in your own files (see the migration).
3. Makes the user `unbrowse-agent`: no password, no admin rights, its own group, and a home only it can read.
4. Writes `UNBROWSE_NODE` and `UNBROWSE_AGENT_TOKEN` into `~unbrowse-agent/.unbrowse-agent.env`, readable by that user
   alone. The token goes in on stdin, never as an argument.
5. On macOS and Linux, writes `/etc/sudoers.d/unbrowse-agent` (checked with `visudo` first). It lets you, and only you,
   run programs as `unbrowse-agent` with no password. It gives `unbrowse-agent` no rights at all.

Running `install` again keeps the user and writes its settings and sudoers rule again, with a new key.

## Run an agent

```sh
unbrowse-node agent-user run -- claude
unbrowse-node agent-user run -- codex
unbrowse-node agent-user run -- sh -c 'unb do "top stories" --url https://news.ycombinator.com'
```

`run` reads the agent's settings as `unbrowse-agent` and runs the program with its arguments as they are. On macOS and
Linux it is `sudo -u unbrowse-agent -H`. On Windows it starts the program with the agent user's logon. The node kept
that password in your Credential Manager at install.

The agent user has its own home, so:

- **The harness logs in again as that user.** The first `run -- claude` asks you to sign in to Claude Code there.
- **MCP goes through `unb mcp`, which signs each request with the token (the token never goes over the wire):**
  `unbrowse-node agent-user run -- claude mcp add --scope user unbrowse -- unb mcp` (the agent user's own environment
  file gives `unb mcp` its token as Claude starts it: the token is in no command line and no config).
- **`unb` and the harness must be where it can run them.** Use a system-wide install (`/usr/local/bin`,
  `C:\Program Files`), not one inside your home, which it can't open.
- **It can't read your project folders.** That is the point. To work on one, give the folder to a group you share with
  it, or copy what it needs into its home.

## Check it

```sh
unbrowse-node agent-user status
```

Run as `unbrowse-agent`, it tries to list your node's folder and read every file in it. It prints each one it could and
exits 1. Otherwise it says that none of them can be read. CI runs install, status, run and remove for real on macOS,
Linux and Windows (`unbrowse-node/scripts/agent-user-e2e.sh`, `.ps1`).

## Existing installs: the migration

An agent you set up before this runs as you and holds its token in your own files: a shell profile, an MCP config, a
plugin's `.env`. Any program running as you can read it there. To move:

1. **Update the node, and start it once.** Each start makes `~/.unbrowse` and everything directly in it yours alone,
   whatever an older version left it as.
2. **`unbrowse-node agent-user install`.** As well as the steps above, it looks through your home, three folders deep
   (skipping the node's own folder and build or package folders), for every file that holds a live agent key's token.
   It lists each file and the key.
3. **Set each listed agent up again as `unbrowse-agent`** (`agent-user run -- <harness>`, then its MCP or `.env` setup
   with `$UNBROWSE_AGENT_TOKEN`). Then delete the token from the listed files.
4. **`unbrowse-node agent-user install --revoke-found`** revokes the keys whose tokens were found in your files. Once
   revoked, a copy left behind does nothing.
5. **Restart the node** (`unbrowse-node restart`). `owner.token` is new on every start, so a copy an old agent read
   stops working.

## Remove

```sh
unbrowse-node agent-user remove
```

It removes the user, its home and its sudoers rule, and on Windows the password the node kept. The agent key it used
still works until you revoke it (the window's Money, Agents, or the SDK's `agent_revoke`).

## What it does on each OS

| | Linux | macOS | Windows |
|---|---|---|---|
| The user | `useradd --system --user-group`: no password, its own group, no login shell (`/usr/sbin/nologin`); sudo gives what it runs a terminal of its own (`use_pty`) | `dscl`: UID and GID free below 500 (hidden), its own group (never `staff`), password `*`, `IsHidden 1`, no login shell (`/usr/bin/false`) | `New-LocalUser`, a standard user in `Users` only, with a random password kept in the owner's Credential Manager |
| Its home | `/var/lib/unbrowse-agent`, 0700 | `/Users/unbrowse-agent`, 0700 | `%ProgramData%\Unbrowse\agent`, no inherited access, only it, the owner and SYSTEM |
| Running as it | sudoers rule, `sudo -u` | sudoers rule, `sudo -u` | a process started with its logon (`ProcessStartInfo`) |
| The owner's secrets | `~/.unbrowse` 0700, its files without group or other bits; Secret Service per user | the same; the Keychain per user | the owner's profile, which only the owner, SYSTEM and Administrators can open; Credential Manager per user |

## What it doesn't close

- **The node's browser.** Chrome's DevTools port is on `127.0.0.1` and takes no token. Any local user, the agent user
  included, can connect to it and drive the node's browser with its sessions. This is item 7 of the same review
  (local browser control ports), which was out of scope here. Until it is fixed, the agent user can reach logged-in
  sites through that port, but it still can't reach the owner's token, keys or passphrase.
- **Administrators.** An admin, or anyone who can `sudo` to root, reads everything. Never give the agent user admin
  rights, and never run an agent as root.
- **Files outside the node's folder.** The agent user can still read what your home lets every user read (on many
  Linux systems your home is 0755). `install` changes only `~/.unbrowse`.
