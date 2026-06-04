/**
 * `unbrowse act submit [selector]` — form submission.
 *
 * 1:1 mapping (kind-map.ts row "act submit"):
 *   CLI subcommand  : act submit
 *   MCP tool        : unbrowse_submit
 *   Op kind   : act:submit
 *   Verb            : act
 *
 * No value-bearing: this handler NEVER touches src/values/.
 *
 * Composition:
 *   - With selector: Runtime.evaluate(`document.querySelector(s).form ?? document.querySelector(s)`)
 *     then call requestSubmit() (falls back to submit() when requestSubmit
 *     isn't available, which it always is on modern Chrome but the fallback
 *     keeps the surface honest).
 *   - Without selector: walk from document.activeElement up the parent chain
 *     to the nearest <form> ancestor and submit it.
 *
 * Returns the form's action + method + element count so the agent can
 * confirm the right form fired.
 *
 * Exit codes:
 *   0   success
 *   65  EX_DATAERR — no form found / CDP error
 *   1   generic failure
 */
import { attach, attachToTarget, call } from "../../cdp/index.js";
import type { ParsedV7Args } from "../args.js";
import { resolveSession } from "../_session.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { emitBreathActStateless } from "../_act-audit.js";

const EX_CDP = 65;

/**
 * The page-side submit script. Locates the form (per `selectorJson`: either
 * a CSS selector string OR `null` to use activeElement), calls
 * `requestSubmit()` (falling back to `submit()`), and returns a small
 * pointer-shaped descriptor of what was submitted.
 *
 * Kept as a single Runtime.evaluate so the form lookup + submit happen in
 * one round-trip and there is no race between "find form" and "submit".
 */
function buildSubmitExpression(selector: string | null): string {
  // JSON.stringify gives a safe JS-string literal — handles quotes, newlines,
  // unicode without escaping issues.
  const selectorLit = selector === null ? "null" : JSON.stringify(selector);
  return `
    (() => {
      const sel = ${selectorLit};
      let form = null;
      if (sel === null) {
        // Walk activeElement up to nearest <form> ancestor.
        let el = document.activeElement;
        while (el && el !== document.body) {
          if (el.tagName === "FORM") { form = el; break; }
          if (el instanceof HTMLElement && el.form instanceof HTMLFormElement) {
            form = el.form; break;
          }
          el = el.parentElement;
        }
      } else {
        const node = document.querySelector(sel);
        if (!node) {
          return { ok: false, error: "selector_not_found", selector: sel };
        }
        if (node.tagName === "FORM") {
          form = node;
        } else if (node.form instanceof HTMLFormElement) {
          form = node.form;
        }
      }
      if (!form) {
        return { ok: false, error: "no_form_found" };
      }
      const action = form.action || "";
      const method = (form.method || "get").toLowerCase();
      const element_count = form.elements ? form.elements.length : 0;
      let how = "requestSubmit";
      try {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          how = "submit";
          form.submit();
        }
      } catch (err) {
        return { ok: false, error: "submit_threw", message: String(err && err.message || err) };
      }
      return { ok: true, action, method, element_count, how };
    })()
  `;
}

interface SubmitResult {
  ok: boolean;
  error?: string;
  selector?: string;
  message?: string;
  action?: string;
  method?: string;
  element_count?: number;
  how?: string;
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("act", "submit")!;

  if (parsed.wantsHelp) {
    helpExit(
      "act submit",
      {
        summary: "Submit a form (optionally targeted by selector).",
        usage: "unbrowse act submit [selector] [--session <id>] [--wait] [--timeout <ms>]",
        positional: [
          {
            name: "selector",
            description: "CSS selector of the <form> or a form-bound element. If omitted, uses activeElement's form ancestor.",
            required: false,
          },
        ],
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
          { name: "--wait", description: "Wait for navigation after submit (default: false in v7.0)." },
          { name: "--timeout", description: "Navigation wait timeout in ms.", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "act",
      },
      opts,
    );
  }

  const selector = parsed.positional[0] ?? null;
  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;

  let rec;
  try {
    rec = await resolveSession(sessionFlag);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  let result: SubmitResult;
  let currentUrl = "";
  try {
    const conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);
    const targetSessionId = target.sessionId;

    try {
      const hist = await call<
        Record<string, never>,
        { currentIndex: number; entries: Array<{ url: string }> }
      >(conn, "Page.getNavigationHistory", {}, targetSessionId);
      currentUrl = hist.entries[hist.currentIndex]?.url ?? "";
    } catch {
      currentUrl = "";
    }

    const expr = buildSubmitExpression(selector);
    const res = await call<
      { expression: string; returnByValue: boolean; awaitPromise: boolean },
      {
        result: { value?: SubmitResult };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }
    >(
      conn,
      "Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: false },
      targetSessionId,
    );

    if (res.exceptionDetails) {
      const msg =
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
      throw new Error(`submit_eval_failed:${msg}`);
    }
    result = res.result.value ?? { ok: false, error: "no_result" };
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  if (!result.ok) {
    emit(
      {
        ok: false,
        subcommand: "act submit",
        op_kind: meta.op_kind,
        session_id: rec.sessionId,
        selector: selector ?? null,
        error: result.error ?? "submit_failed",
        message: result.message,
      },
      opts,
    );
    process.exit(EX_CDP);
  }

  // Day-6 Dominion: emit a sig-keyed act-act receipt for this
  // submit. Optional selector is sha256-hashed by the helper. The
  // form's `action` URL is NOT hashed into the audit — that's a
  // navigation pointer, not a forensic locator for the submit gesture
  // itself; the URL the user submitted FROM is the binding.
  // Binding-missing surfaces as a stderr warning, never blocks the
  // gesture (A5).
  const breathAudit = await emitBreathActStateless({
    sessionId: rec.sessionId,
    actType: "submit",
    selector: selector ?? null,
    currentUrl,
  });

  emit(
    {
      ok: true,
      subcommand: "act submit",
      op_kind: meta.op_kind,
      session_id: rec.sessionId,
      selector: selector ?? null,
      action: result.action,
      method: result.method,
      element_count: result.element_count,
      how: result.how,
      audit: {
        ok: breathAudit.ok,
        idempotent: breathAudit.idempotent,
        binding_missing: breathAudit.bindingMissing,
        receipt_id: breathAudit.receiptId,
        cache_key: breathAudit.cacheKey,
        variant: "act-act",
        act_type: "submit",
      },
    },
    opts,
  );
  process.exit(0);
}
