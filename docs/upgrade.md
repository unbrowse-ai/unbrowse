# Moving to the new Unbrowse

Unbrowse used to run on our servers. The hosted service closed in November 2026, and the new version runs on your own
computer. Your agent talks to a small program on your machine (the node), and the node talks to websites for it. Your
sign-ins to websites stay on your computer.

If you set Unbrowse up with version 12 or earlier, this page is for you. Moving takes about a minute, and you can
undo it.

## The short version

Open a terminal and run:

```bash
npm i -g unbrowse
unbrowse connect
```

`unbrowse connect` shows you what it found and what it plans to change, and asks before it changes anything. When it is
done, restart your agent (Claude Code, Codex, Cursor or whichever you use).

You need Node 20.3 or newer. The new Unbrowse runs on macOS, Linux and Windows.

## What `unbrowse connect` does

1. **Looks first.** It finds every old Unbrowse entry in your agents' settings and lists them. It doesn't change
   anything yet.
2. **Asks you.** It shows the plan and waits for your yes. To see the plan without changing anything, run
   `unbrowse connect --dry-run`. Without a terminal (a script, say) it only shows the plan, unless you add `--yes`.
3. **Saves a copy.** Before it changes a setting, it saves the old one in `~/.unbrowse/migration/`, so it can put it
   back later.
4. **Adds the new Unbrowse and checks it works.** The old entry is removed only after the new one answers. If the new
   one doesn't answer, nothing is removed and your old settings stay as they were.
5. **Tells you what it did,** including anything it couldn't change for you.

The new entry keeps the name `unbrowse`, so prompts and skills that mention Unbrowse keep working.

## What stays the same

- **Your old sign-in files.** `~/.config/unbrowse/` and `~/.unbrowse/config.json` are left exactly as they are.
- **Settings that aren't ours.** If you have your own entry with "unbrowse" in its name, `connect` leaves it alone and
  tells you about it.
- **Your edits to the Unbrowse skill.** If you changed `~/.claude/skills/unbrowse`, your copy is moved aside, not
  deleted.

## Your saved logins

Logins you saved on the hosted service did not move to your computer. Add the ones you need again. For a site you are
already signed in to in your own browser, this is often quickest:

```bash
unbrowse session import <site>
```

To keep a password for a site, `unbrowse vault add <site> <account> --stored` reads it from standard input, and
`unbrowse vault import <file>` brings in a login export from your browser or password manager. The node keeps them
sealed on your computer. [CLI.md](CLI.md) lists every command.

## Agents `connect` can't change for you

`connect` changes Claude Code itself. For Codex, Cursor, VS Code, Gemini, Zed and others, it prints the exact line to
change and the file it goes in. The same lines are in [Install the Unbrowse MCP](install-mcp.md). For Codex, the
installer in [integrations/codex](../integrations/codex/README.md) swaps the old entry for you and keeps a copy of the
old file.

## If something goes wrong

- **The new entry didn't answer.** Nothing was removed. Open the Unbrowse app, approve your agent, then run
  `unbrowse connect` again.
- **Your agent can't see Unbrowse after moving.** Restart the agent. It reads its settings when it starts.
- **Your agent still shows the hosted tools, or says the service has moved.** An old entry is still there. Run
  `unbrowse connect --dry-run` to find it, then `unbrowse connect`.
- **You want to undo what `connect` did.** Run `unbrowse connect --undo`. It puts your old entries back and removes the
  new one. Those old entries point at the hosted service, which has closed, so use this only if `connect` changed
  something you didn't want. `unbrowse connect --undo --purge` also deletes the saved copy.

## Questions

- **Do I have to move today?** Your old setup stops working when the hosted service does, and it has. Until you run
  `unbrowse connect`, your agent hears how to move instead of getting an answer from a site.
- **Will I lose anything?** `connect` deletes nothing. Old settings are saved before they change, and your sign-in
  files aren't touched. The saved logins from the hosted service are the exception: see above.
- **Is my agent allowed to run this for me?** Please run it yourself. `connect` asks you questions and shows you what
  changes.
- **Where do I get help?** [Open an issue](https://github.com/unbrowse-ai/unbrowse/issues).
