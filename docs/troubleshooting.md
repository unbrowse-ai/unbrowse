# Troubleshooting

| Symptom | What to do |
|---|---|
| Installed CLI shows 11.x | Use the explicit hosted-client release in [install.md](install.md). `npm latest` is independently published. |
| Skill installed but no Unbrowse tools | Add the [remote MCP](mcp.md), authenticate, then refresh the client's tools. Skills are instructions, not connections. |
| CLI 401 / exit 3 | Run `unbrowse login`, or provide a valid `UNBROWSE_API_KEY`. Check `unbrowse whoami`. |
| Agent and canvas show different data | Use the same signed-in Unbrowse account; API keys belong to the workspace that created them. |
| Website needs a login | Save it via the returned Unbrowse save-login link. Your Unbrowse sign-in does not sign you in to every website. |
| `input_required` / exit 2 | Answer the listed fields with `unbrowse resume RUN_ID field=value` on the same run. |
| `no_capability` | Use the cloud-browser tools through MCP or submit authorized recordings. The CLI does not run a local browser. |
| Bot check / MFA / human verification | Use the supported handoff. A challenge page isn't a successful result. Some sites remain unsupported. |
| `outcome_unknown` / exit 4 | Inspect the run and destination. Do not repeat a write until its effect is known. |
| Quota or payment refusal | Check `unbrowse usage` and the console plan. Retries do not increase the quota. |
| `accepted` or `working` | Request remains pending. Inspect later; exit 0 for accepted dispatch does not prove completed work. |

For an issue, include the client version, command name, HTTP/error code and sanitized reproduction. Remove tokens, cookies, private results, HAR contents and one-time login links. Report vulnerabilities according to [SECURITY.md](../SECURITY.md).
