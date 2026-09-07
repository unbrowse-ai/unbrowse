/**
 * `unbrowse breath run-js <expression>` — evaluate in the persisted browse
 * session, using the same stateless CDP/Obscura reattachment as snap/text.
 *
 * ISSUE-4: a target can accept the crossing and never answer. The bound is
 * applied at the verb boundary so `run-js` shares `breath go`'s wall clock.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { emit } from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { resolveSession } from "../_session.js";
import { attach, attachToTarget, call } from "../../cdp/index.js";
import type { RuntimeEvaluateResult } from "../../cdp/types.js";
import { isObscuraSession, obscuraClient } from "../../obscura/live-page.js";
import { guardAct, parseActTimeoutMs } from "./_act-deadline.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const timeoutMs = parseActTimeoutMs(parsed.flags);
  const meta = lookupKindMap("breath", "run-js");
  const expression = parsed.positional.join(" ");
  const sessionId = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;

  await guardAct(
    {
      subcommand: "breath run-js",
      opKind: meta?.op_kind ?? "breath:run_js",
      // Name the expression, not just "eval" — a caller with several run-js
      // calls in flight needs to know WHICH one the target stopped answering.
      waitingOn: `POST /v1/browse/eval evaluating \`${expression.slice(0, 200)}\``,
      timeoutMs,
      opts,
      ...(sessionId ? { sessionId } : {}),
    },
    async () => {
      const rec = await resolveSession(sessionId);
      let result: unknown;

      if (isObscuraSession(rec)) {
        result = await obscuraClient(rec).evaluate(expression);
      } else {
        const conn = await attach(rec.chromeWsUrl);
        const target = await attachToTarget(conn, rec.targetId);
        const evaluated = await call<
          { expression: string; awaitPromise: boolean; returnByValue: boolean; userGesture: boolean },
          RuntimeEvaluateResult
        >(
          conn,
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true, userGesture: true },
          target.sessionId,
        );
        if (evaluated.exceptionDetails) {
          throw new Error(`runtime_evaluate_failed:${evaluated.result.description ?? "page expression threw"}`);
        }
        result = evaluated.result.value;
      }

      emit(
        {
          ok: true,
          subcommand: "breath run-js",
          op_kind: meta?.op_kind ?? "breath:run_js",
          session_id: rec.sessionId,
          target_id: rec.targetId,
          result,
        },
        opts,
      );
    },
  );
}
