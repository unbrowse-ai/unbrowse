# Telemetry and bug reports

The node can tell Unbrowse how it is used (anonymous counts: which tool ran, did it work, how long) and can file problems as public issues. Both follow the owner's choice and are off on a scratch run. An agent that sees a wrong answer, a block page served as a success or a failed call reports it with `unbrowse_report`. The node scrubs the report and shows what it would send. A report written by an agent waits for the owner to read and send it. Nothing a person browsed, called or kept is ever in telemetry.

## Sub-features

- `telemetry-state` shows on or off, what set it, what is sent and the install id.
- `telemetry-off` stops sending at once, and `telemetry on` takes the next start.
- `telemetry-env-wins` lets `UNBROWSE_TELEMETRY=0` beat the saved choice.
- `reports-state` shows bug reports on or off and what a report holds.
- `reports-off-by-telemetry` keeps reports off whenever telemetry is off.
- `report-agent` accepts a report from an agent: kind, summary, expected, got.
- `report-reply` says `waiting_for_owner`, `off` or `refused`, and shows the scrub.
- `report-owner-queue` lists waiting reports and lets the owner send or discard one.
- `report-bad-kind` refuses a kind outside `wrong_data`, `false_success`, `failed`, `slow`, `confusing`, `other`.
- `telemetry-worker-schema` holds the worker and the node to the same fields (`unbrowse-telemetry/schema.json`).

## How to get to it (user POV)

- CLI: `unbrowse-node telemetry [on|off]`, `unbrowse-node reports [on|off]`; `unb report <kind> <summary> --expected <what> --got <what>`.
- MCP: `unbrowse_report`. HTTP: `POST /v1/report`. SDK: `report(...)`.
- Owner commands: `reports_waiting`, `report_send`, `report_discard`.
- Environment: `UNBROWSE_TELEMETRY`, `UNBROWSE_REPORTS`, `UNBROWSE_TELEMETRY_URL`, `UNBROWSE_REPORTS_URL`.
- Files: `telemetry.json`, `reports.json` and `report.key` in the node's home.
- Window: Settings and the owner's report prompt (see `window.md`).
- Worker: `POST /v1/events` and `POST /v1/reports` at `telemetry.unbrowse.ai`, tested in `unbrowse-telemetry/`.

## Driving it with unbrowse-verify

Preconditions:

- A scratch node is healthy. Its start sets `UNBROWSE_TELEMETRY=0` and `UNBROWSE_REPORTS=0`.
- Nothing here talks to the real relay. The recipes read state and never send.

- **Telemetry state.** Run `unbrowse-verify node -- telemetry`. It prints `telemetry: off (set by UNBROWSE_TELEMETRY)`, what it sends, and an install id of 32 hex characters.
- **Reports state.** Run `unbrowse-verify node -- reports`. It says reports are off, that telemetry or `UNBROWSE_REPORTS` set it, and what a report holds.
- **Start line.** Run `unbrowse-verify logs --grep telemetry`. The node's start lines say whether telemetry and bug reports are on. Both read off.
- **Usage error.** Run `unbrowse-verify node -- telemetry maybe`. The usage line `usage: unbrowse-node telemetry [on | off]` is on stderr and the exit code is 2.
- **Env wins.** Run `unbrowse-verify node -- telemetry on`, then `unbrowse-verify node -- telemetry`. It still reads off, set by the environment. Run `telemetry off` after.
- **Agent report with reports off.** Run `unbrowse-verify api POST /v1/report --body '{"kind":"other","summary":"verification check, do not file","expected":"nothing","got":"nothing"}'`. The reply's `report` is `off`. Nothing leaves the machine.
- **Same through MCP.** Run `unbrowse-verify mcp unbrowse_report --args '{"kind":"other","summary":"verification check, do not file","expected":"nothing","got":"nothing"}'`. The reply matches the HTTP one.
- **Bad kind.** Run `unbrowse-verify api POST /v1/report --body '{"kind":"nonsense","summary":"x","expected":"x","got":"x"}'`. The reply is a refusal that names the kinds.
- **Owner queue.** Run `unbrowse-verify owner reports_waiting`. It is empty, since reports are off.
- **Worker tests.** Run `npm test` in `unbrowse-telemetry`. It runs the worker's tests, including the scrub, against `schema.json`.

## Gotchas

- Never turn reports on and never run `report_send`. A sent report becomes a public GitHub issue on `unbrowse-ai/unbrowse`. The scratch run must not file anything.
- Nothing can prove telemetry arrives. Scratch is off by design. The only provable facts are the off state, the refusal to send, and the worker's own tests. Report delivery as not proven.
- The `unbrowse_report` text must hold no personal data, URL query, token or vault reference. Use the placeholder words above only.
- A report with reports off may answer `off` before it shows the scrub. If the scrub text is missing, report that the scrub was not seen, not that it passed.
- `UNBROWSE_TELEMETRY` and `UNBROWSE_REPORTS` beat the saved files. A `telemetry on` in a scratch run changes only the scratch home's `telemetry.json`.
- A node kept off the peer network sends nothing even with telemetry on. Do not read silence as a pass for the scrub.
- The worker's tests may write a local store. Run them in a clean checkout state and record that.
- Never run the worker's deploy (`wrangler`). This map does not deploy.
