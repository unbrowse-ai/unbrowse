## Test what you build (inherited, non-negotiable)

A harness that BUILDS X must TEST X against the live served surface, not
against the source code that was edited. Preflight gates (typecheck,
build, lint, py_compile, format) are necessary but NEVER sufficient. A
green verify with only preflight is a fake-green; the artifact may still
be a regression to a real user.

For every artifact the build introduces or modifies, verify.sh authors a
real-channel assertion that exercises the deployed surface end to end:

- API endpoint built or changed: POST/GET the deployed URL with a real
  payload, assert response status AND response shape AND that the
  response body reflects work the backend actually did (not the request
  echoed back).
- Streaming surface built or changed: consume the stream to completion,
  assert chunks arrive in order, assert at least one non-empty body
  frame, assert the terminator/close. A 200 status with zero body is the
  failure mode this lane exists to catch.
- Database write built or changed: after the action, read the row back
  from the live DB by id and assert the persisted fields, not the fields
  the caller sent. Echo-from-request is not persistence.
- Frontend render built or changed: drive the deployed URL with
  agent-browser or an equivalent real-DOM channel, perform the user
  action, observe the rendered DOM or a screenshot for the expected
  state. A build that compiles is not a UI that renders.
- Job, queue, or async pipeline built or changed: enqueue a real
  payload, wait for the terminal event on the real channel, assert the
  side effect landed in its actual destination.

Operating rule: if the artifact, when broken, would be a regression to a
real user, verify must exercise the user path. If no real channel is
reachable in this environment, verify fails closed with TODO declare
validation_channel, surfacing the missing capability by name. It never
papers over with a preflight-only green.

Enforcement (substrate-faithful, evidence only): substrate-audit.sh
emits real_channel_lines, proxy_gate_lines, and proxy_only_gate_lines
as raw rows in ledgers/gates.jsonl every iterate, and the agent judges
whether the artifact served surface was exercised. The gate does not
auto-decide PROMOTE or HOLD; it surfaces evidence and the agent reads
it. The diagnostic question at every wave is "did this verify touch
the artifact user-facing surface, or only the source?", never "did
the build compile?".
