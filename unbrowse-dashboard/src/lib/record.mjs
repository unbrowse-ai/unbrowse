// One CI run as the dashboard keeps it. The collector builds it, the Worker checks it before it is stored.

export const METRICS = [
  "slice_right", "slice_aside", "slice_wrong", "slice_fail", "slice_error", "slice_tasks",
  "full_right", "full_aside", "full_wrong", "full_fail", "full_error", "full_tasks",
  "qa_pass", "qa_checks_pass", "qa_checks_total",
  "cost_usd",
  "coverage_pct", "coverage_covered", "coverage_total",
  "bank_pass", "bank_total",
  "hard_right", "hard_wrong", "hard_browser", "hard_walled", "hard_unknown",
];
export const HARD_LABELS = ["right", "wrong", "needs a browser", "walled", "unknown"];
const CONCLUSIONS = ["success", "failure", "cancelled", "skipped", "timed_out", "neutral", "action_required", "stale", "startup_failure"];

const isIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));

// Returns { record } with only known fields, or { error }.
export function checkRecord(input) {
  if (!input || typeof input !== "object") return { error: "not an object" };
  const r = input;
  if (!Number.isSafeInteger(r.run_id) || r.run_id <= 0) return { error: "run_id" };
  for (const k of ["workflow", "branch", "sha", "event"]) {
    if (typeof r[k] !== "string" || !r[k] || r[k].length > 200) return { error: k };
  }
  if (!/^[0-9a-f]{7,40}$/.test(r.sha)) return { error: "sha" };
  if (!CONCLUSIONS.includes(r.conclusion)) return { error: "conclusion" };
  if (!isIso(r.started_at) || !isIso(r.finished_at)) return { error: "times" };
  const metrics = {};
  for (const [k, v] of Object.entries(r.metrics ?? {})) {
    if (!METRICS.includes(k)) return { error: `metric ${k}` };
    if (typeof v !== "number" || !Number.isFinite(v)) return { error: `metric ${k}` };
    metrics[k] = v;
  }
  const sites = [];
  for (const s of r.sites ?? []) {
    if (typeof s?.site !== "string" || !s.site || s.site.length > 200) return { error: "site" };
    if (!HARD_LABELS.includes(s.label)) return { error: "site label" };
    sites.push({ site: s.site, label: s.label, seconds: Number.isFinite(s.seconds) ? s.seconds : null });
  }
  if (sites.length > 100) return { error: "sites" };
  const wall = (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000;
  return {
    record: {
      run_id: r.run_id,
      attempt: Number.isSafeInteger(r.attempt) && r.attempt > 0 ? r.attempt : 1,
      workflow: r.workflow,
      branch: r.branch,
      sha: r.sha,
      event: r.event,
      conclusion: r.conclusion,
      started_at: new Date(r.started_at).toISOString(),
      finished_at: new Date(r.finished_at).toISOString(),
      wall_s: wall >= 0 ? Math.round(wall) : null,
      metrics,
      sites,
    },
  };
}
