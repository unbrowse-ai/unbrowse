// Read a CI run's artifacts into dashboard metrics. Pure: text in, numbers out. Anything unreadable is left out,
// never guessed.

// Which artifacts of which workflow hold numbers. Workflows not listed still get wall-clock and conclusion.
export const ARTIFACTS = {
  "Gate bank": [/^gate-bank-(slice|full)-/],
  QA: [/^qa-report$/],
  Bank: [/^bank$/, /^hard-sites-report$/],
  Coverage: [/^coverage-summary-/],
};
export const WORKFLOWS = ["CI", "Coverage", "QA", "Gate bank", "Bank"];

const num = (s) => (s === undefined ? undefined : Number(s));

// gate.py's verdict block: "right 7, set aside 1, confidently wrong 1, honest fail 0, error 0, ..."
export function parseVerdict(text) {
  const line = text.split("\n").find((l) => /\bright \d+, set aside \d+/.test(l));
  if (!line) return null;
  const get = (label) => num(line.match(new RegExp(`${label} (\\d+)`))?.[1]);
  const tasks = num(text.match(/\((?:slice of )?(\d+) tasks/)?.[1]);
  const out = { right: get("right"), aside: get("set aside"), wrong: get("confidently wrong"), fail: get("honest fail"), error: get("error") };
  if (tasks !== undefined) out.tasks = tasks;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => Number.isFinite(v)));
}

// Model spend of a bank run: the client's and the judge's cost per task.
export function parseResultsCost(jsonl) {
  let total = 0;
  let seen = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    for (const c of [row?.meta?.total_cost_usd, row?.judge_meta?.total_cost_usd]) {
      if (typeof c === "number" && Number.isFinite(c)) {
        total += c;
        seen++;
      }
    }
  }
  return seen ? Math.round(total * 10000) / 10000 : undefined;
}

export function parseQa(verdictText, costText) {
  const out = {};
  try {
    const v = JSON.parse(verdictText);
    if (typeof v.pass === "boolean") out.qa_pass = v.pass ? 1 : 0;
    if (Array.isArray(v.checks)) {
      out.qa_checks_total = v.checks.length;
      out.qa_checks_pass = v.checks.filter((c) => c?.result === "pass").length;
    }
  } catch {}
  if (costText) {
    try {
      const c = JSON.parse(costText).total_cost_usd;
      if (typeof c === "number" && Number.isFinite(c)) out.cost_usd = Math.round(c * 10000) / 10000;
    } catch {}
  }
  return out;
}

// bank.yml's reads.md: "**Read regression: 5 of 13 sites still pass their checks, ..."
export function parseBankReads(text) {
  const m = text.match(/(\d+) of (\d+) sites? still pass/);
  return m ? { bank_pass: Number(m[1]), bank_total: Number(m[2]) } : {};
}

export function parseCoverage(text) {
  try {
    const all = JSON.parse(text).rust_all;
    if (Number.isFinite(all?.pct)) return { coverage_pct: all.pct, coverage_covered: all.covered, coverage_total: all.total };
  } catch {}
  return {};
}

const HARD_KEY = { right: "hard_right", wrong: "hard_wrong", "needs a browser": "hard_browser", walled: "hard_walled", unknown: "hard_unknown" };

export function parseHardSites(text) {
  try {
    const j = JSON.parse(text);
    const metrics = {};
    for (const [label, key] of Object.entries(HARD_KEY)) if (Number.isFinite(j.counts?.[label])) metrics[key] = j.counts[label];
    const sites = (j.rows ?? [])
      .filter((r) => typeof r?.site === "string" && r.label in HARD_KEY)
      .map((r) => ({ site: r.site, label: r.label, seconds: Number.isFinite(r.seconds) ? r.seconds : null }));
    return { metrics, sites };
  } catch {
    return { metrics: {}, sites: [] };
  }
}

// files: { "<artifact name>/<path inside>": text }. Returns { metrics, sites }.
export function metricsFrom(workflow, files) {
  const metrics = {};
  let sites = [];
  const find = (re) => Object.keys(files).filter((p) => re.test(p));
  if (workflow === "Gate bank") {
    for (const p of find(/^gate-bank-(slice|full)-[^/]+\/(?:.*\/)?verdict\.md$/)) {
      const scope = p.startsWith("gate-bank-full-") ? "full" : "slice";
      const v = parseVerdict(files[p]);
      if (v) for (const [k, n] of Object.entries(v)) metrics[`${scope}_${k}`] = n;
    }
    let cost;
    for (const p of find(/^gate-bank-(slice|full)-[^/]+\/(?:.*\/)?results\.jsonl$/)) {
      const c = parseResultsCost(files[p]);
      if (c !== undefined) cost = (cost ?? 0) + c;
    }
    if (cost !== undefined) metrics.cost_usd = Math.round(cost * 10000) / 10000;
  } else if (workflow === "QA") {
    const v = find(/^qa-report\/(?:.*\/)?qa-verdict\.json$/)[0];
    const c = find(/^qa-report\/(?:.*\/)?qa-cost\.json$/)[0];
    if (v) Object.assign(metrics, parseQa(files[v], c ? files[c] : ""));
  } else if (workflow === "Bank") {
    const r = find(/^bank\/(?:.*\/)?reads\.md$/)[0];
    if (r) Object.assign(metrics, parseBankReads(files[r]));
    const h = find(/^hard-sites-report\/(?:.*\/)?hard-sites\.json$/)[0];
    if (h) {
      const hs = parseHardSites(files[h]);
      Object.assign(metrics, hs.metrics);
      sites = hs.sites;
    }
  } else if (workflow === "Coverage") {
    const s = find(/^coverage-summary-[^/]+\/(?:.*\/)?coverage-summary\.json$/)[0];
    if (s) Object.assign(metrics, parseCoverage(files[s]));
  }
  return { metrics, sites };
}
