// Derive an actionable next_step for a failed proven_recipe replay.
export function deriveRecipeReplayNextStep(
  reason: string | undefined,
  context: { url: string; status: number; endpointId: string },
): string {
  const target = context.url || context.endpointId || "the captured endpoint";
  const suffix = ` (endpoint=${context.endpointId || "unknown"}, url=${context.url || "unknown"})`;
  let body: string;
  // matchResponseSignal at src/execution/index.ts:3419-3441 emits prefixed
  // reasons like "status_changed: 200 -> 404", "missing_top_keys: data,error",
  // "body_shrunk: 12B < min 100B", "body_grew: 999B > max 500B". The dispatch
  // matches on the prefix before the colon.
  const prefix = (reason ?? "").split(":")[0]?.trim();
  switch (prefix) {
    case "status_changed":
      body =
        `Recipe replay returned a different HTTP status than the captured ` +
        `proven_recipe expected (${reason}). The endpoint contract has ` +
        "shifted upstream; re-resolve with `--force-capture` to refresh the " +
        "recipe against the current contract.";
      break;
    case "missing_top_keys":
      body =
        `Recipe replay body is missing top-level keys the proven_recipe ` +
        `expected (${reason}). The response schema has changed; re-resolve ` +
        `with \`unbrowse resolve --force-capture ${target}\` to refresh the ` +
        "stored signal.";
      break;
    case "body_shrunk":
    case "body_grew":
      body =
        `Recipe replay body is outside the captured byte-length window ` +
        `(${reason}). The endpoint may be returning a stub, an error page, ` +
        "or paginated data; re-resolve with `--force-capture` and inspect " +
        "via `unbrowse explain` before publishing.";
      break;
    case "signal-mismatch":
      body =
        "Recipe response_signal validator rejected the replay body; the " +
        "site's response shape or fingerprint has shifted. Re-capture a " +
        `fresh proven_recipe by running \`unbrowse resolve --force-capture ${target}\`.`;
      break;
    case "status-mismatch":
      body =
        `Recipe replay returned HTTP ${context.status} but the stored ` +
        "proven_recipe expected a different status. The endpoint contract " +
        "has changed upstream; re-resolve with `--force-capture` to refresh " +
        "the recipe.";
      break;
    case "recipe-missing-field":
      body =
        "Stored proven_recipe is missing a required field (likely written " +
        "by an older capture pipeline). Re-publish the skill via " +
        "`unbrowse review` then `unbrowse publish`, or re-resolve with " +
        "`--force-capture` to overwrite the descriptor.";
      break;
    case "unknown":
    case "":
    case undefined:
      body =
        "Recipe replay failed without a specific reason. The executor will " +
        "automatically fall back to the probe path; if that also fails, " +
        "re-resolve with `unbrowse resolve --force-capture` for a fresh " +
        "capture.";
      break;
    default:
      body =
        `Recipe replay failed with reason "${reason}". The executor will ` +
        "fall back to the probe path; for a fresh capture, re-resolve with " +
        "`--force-capture`.";
      break;
  }
  return body + suffix;
}
