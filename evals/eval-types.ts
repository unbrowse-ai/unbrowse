export interface EvalCase {
  id: string;
  intent: string;
  url: string;
  expected_outcome: "resolve" | "capture" | "fail";
  auth_required: boolean;
  tags: string[];
}

export interface EvalResult {
  case_id: string;
  status: "pass" | "fail" | "skip";
  duration_ms: number;
  error?: string;
}

/**
 * Returns true if all results for the same case agree on status.
 * A single result is not enough to determine repeatability (returns false).
 */
export function isRepeatableEval(results: EvalResult[]): boolean {
  if (results.length < 2) return false;
  const statuses = results.map((r) => r.status);
  return statuses.every((s) => s === statuses[0]);
}
