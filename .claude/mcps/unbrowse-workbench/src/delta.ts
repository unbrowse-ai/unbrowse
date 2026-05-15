// Day-5 Creatures: structural_diff_summary for _workbench_delta.
//
// Compute a SHORT human-readable summary of how two MCP `tools/call`
// responses (candidate vs baseline) differ in shape, plus the signed
// bytes/ms deltas the proxy already measures per side.
//
// Scope (Day 5):
//   - identical (deep-equal): "identical"
//   - missing side (null msg from upstream error): "candidate side missing"
//     etc.
//   - root keys differ: "root keys differ: candidate=[a,b] baseline=[a,c]"
//   - same root keys: walk one level deep and report adds/removes/value
//     differences with counts and the first few keys.
//   - cap output at 256 chars.
//
// Day-6 Dominion may extend to deeper JSON-patch style diff. Until then,
// the agent reads the live response itself when finer detail is needed.

import type { SideMeta } from "./fanout.ts";

export interface StructuralDiff {
  bytes_diff: number;
  ms_diff: number;
  structural_diff_summary: string;
}

const SUMMARY_CAP = 256;

function cap(s: string): string {
  if (s.length <= SUMMARY_CAP) return s;
  // Reserve 1 char for the trailing ellipsis marker so consumers can tell
  // the summary was clipped. Using a single byte keeps the cap tight.
  return s.slice(0, SUMMARY_CAP - 1) + "…";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Deep structural equality for JSON-shaped values. Arrays compare by
// length-and-position; objects compare by sorted-keys-and-values.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (!deepEqual(a[ak[i]], b[bk[i]])) return false;
    }
    return true;
  }
  // Primitives that weren't === above (NaN etc.): treat as unequal.
  return false;
}

// Pick the "payload" we want to diff. For a JSON-RPC response, the
// shape worth comparing is `result` or `error`, not the JSON-RPC frame
// (id/jsonrpc). If both have `result`, diff the results. If both have
// `error`, diff the errors. Otherwise fall back to the root.
function payloadOf(msg: Record<string, unknown>): {
  payload: unknown;
  rootKeys: string[];
} {
  const rootKeys = Object.keys(msg).sort();
  if ("result" in msg) return { payload: msg["result"], rootKeys };
  if ("error" in msg) return { payload: msg["error"], rootKeys };
  return { payload: msg, rootKeys };
}

function fmtKeyList(keys: string[], max: number): string {
  if (keys.length <= max) return `[${keys.join(",")}]`;
  return `[${keys.slice(0, max).join(",")},+${keys.length - max} more]`;
}

// Compare two JSON-shaped payloads at depth 1 only.
function describePayloadDiff(candPayload: unknown, basePayload: unknown): string {
  if (deepEqual(candPayload, basePayload)) {
    return "identical";
  }

  // Type-shape divergence: array vs object vs scalar.
  const candIsObj = isPlainObject(candPayload);
  const baseIsObj = isPlainObject(basePayload);
  const candIsArr = Array.isArray(candPayload);
  const baseIsArr = Array.isArray(basePayload);

  if (candIsArr && baseIsArr) {
    const cl = (candPayload as unknown[]).length;
    const bl = (basePayload as unknown[]).length;
    if (cl !== bl) return `array length differs: candidate=${cl} baseline=${bl}`;
    return `array of ${cl} elements with element differences`;
  }

  if (!candIsObj || !baseIsObj) {
    return `payload shape differs: candidate=${typeName(candPayload)} baseline=${typeName(basePayload)}`;
  }

  // Both are plain objects at this point.
  const candKeys = Object.keys(candPayload).sort();
  const baseKeys = Object.keys(basePayload).sort();
  const candSet = new Set(candKeys);
  const baseSet = new Set(baseKeys);
  const added = candKeys.filter((k) => !baseSet.has(k));
  const removed = baseKeys.filter((k) => !candSet.has(k));
  const shared = candKeys.filter((k) => baseSet.has(k));

  if (added.length === 0 && removed.length === 0) {
    // Same key set; count value differences at depth 1.
    const differingKeys = shared.filter(
      (k) =>
        !deepEqual(
          (candPayload as Record<string, unknown>)[k],
          (basePayload as Record<string, unknown>)[k],
        ),
    );
    if (differingKeys.length === 0) {
      // Equal at depth 1 but deepEqual said different: nested-only diff.
      return "values differ in nested structure";
    }
    return `${differingKeys.length} values differ: ${fmtKeyList(differingKeys, 5)}`;
  }

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(
      `${added.length} field${added.length === 1 ? "" : "s"} added: ${fmtKeyList(added, 5)}`,
    );
  }
  if (removed.length > 0) {
    parts.push(
      `${removed.length} field${removed.length === 1 ? "" : "s"} removed: ${fmtKeyList(removed, 5)}`,
    );
  }
  return parts.join("; ");
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function computeStructuralDiff(
  candidateResponse: Record<string, unknown> | null,
  baselineResponse: Record<string, unknown> | null,
  candidate: SideMeta,
  baseline: SideMeta,
): StructuralDiff {
  const bytes_diff = candidate.bytes - baseline.bytes;
  const ms_diff = candidate.ms - baseline.ms;

  if (candidateResponse === null && baselineResponse === null) {
    return {
      bytes_diff,
      ms_diff,
      structural_diff_summary: cap("both sides missing (upstream errored)"),
    };
  }
  if (candidateResponse === null) {
    return {
      bytes_diff,
      ms_diff,
      structural_diff_summary: cap("candidate side missing (upstream errored)"),
    };
  }
  if (baselineResponse === null) {
    return {
      bytes_diff,
      ms_diff,
      structural_diff_summary: cap("baseline side missing (upstream errored)"),
    };
  }

  if (deepEqual(candidateResponse, baselineResponse)) {
    return { bytes_diff, ms_diff, structural_diff_summary: "identical" };
  }

  const cand = payloadOf(candidateResponse);
  const base = payloadOf(baselineResponse);

  // Root keys (the JSON-RPC frame's top level: jsonrpc/id/result/error/...)
  if (cand.rootKeys.join(",") !== base.rootKeys.join(",")) {
    return {
      bytes_diff,
      ms_diff,
      structural_diff_summary: cap(
        `root keys differ: candidate=${fmtKeyList(cand.rootKeys, 6)} baseline=${fmtKeyList(base.rootKeys, 6)}`,
      ),
    };
  }

  // Same root keys (both result OR both error). Diff the payload.
  const summary = describePayloadDiff(cand.payload, base.payload);
  return { bytes_diff, ms_diff, structural_diff_summary: cap(summary) };
}
