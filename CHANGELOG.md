# Changelog

## 13.0.0

**Unbrowse now runs on your own computer.** This release replaces the hosted client (12.x) on npm. The package name is
the same: `npm i -g unbrowse` installs it.

### Moving from 12.x

- `unbrowse connect` finds old Unbrowse entries in Claude Code (user and project scope, and the old plugin), Codex,
  Cursor, VS Code, Gemini and Zed, shows a plan, and asks before changing anything. `--dry-run` shows the plan only;
  `--yes` answers the question for you.
- It saves every setting it changes to `~/.unbrowse/migration/<time>/` first. It removes an old entry only after the new
  one answers `initialize` and `tools/list`.
- `unbrowse connect --undo` puts the old entries back; `--purge` also deletes the saved copy.
- For Codex, Cursor, VS Code, Gemini and Zed it prints the line to change. The Codex installer in `integrations/codex`
  replaces an old `[mcp_servers.unbrowse]` table and keeps the rest of the file.
- Entries it doesn't recognise are left alone and reported.
- Old sign-in files (`~/.config/unbrowse/`, `~/.unbrowse/config.json`) are never changed.
- An old entry that runs `unbrowse mcp` or `npx -y unbrowse mcp` now reaches your node and lists its tools. Until you
  run `unbrowse connect` once, it answers every call with how to do that.
- The Unbrowse skill is replaced when it is an unchanged copy of an older one. A copy you edited is moved to
  `<dir>.before-unbrowse-<time>`, never deleted.
- Saved logins from the hosted service did not move. `unbrowse session import <site>` and `unbrowse vault import <file>`
  bring logins in from your own browser or password manager.

### Notes

- The hosted service closed in November 2026.
- From this release the project is licensed under Apache-2.0. Releases up to 12.5.0 stay MIT.
- The contracts' sources live in a separate private repository. The node ships the compiled contracts it deploys and
  checks against.

Full guide: [Moving to the new Unbrowse](docs/upgrade.md).
