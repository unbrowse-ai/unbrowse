export type ExplorationKind = "filter" | "pagination" | "detail";

export interface ExplorationAction {
  kind: ExplorationKind;
  action: "click" | "check";
  ref: string;
  role: string;
  label: string;
}

export interface ExplorationBudget {
  maxActions?: number;
  maxFilters?: number;
  maxPagination?: number;
  maxDetails?: number;
}

const DENY = /\b(apply|login|log in|logout|log out|sign in|sign up|delete|remove|purchase|buy|checkout|pay|save|message|upload|download|submit|create account|register)\b/i;
const PAGINATION = /^(next|next page|show more|load more|more results|[›»❯])$/i;
const FILTER = /\b(filter|remote|responsive|posted|date posted|employment|job type|location|salary|government support|fresh graduate|mid-career|full time|part time|contract|internship)\b/i;
const NON_DETAIL = /\b(home|about|contact|privacy|terms|feedback|faq|search jobs|explore paths|join events|apply scheme|employer)\b/i;

/** Parse the stable compact AX format emitted by Kuri (`[eN] role "name"`). */
export function parseExplorationCandidates(snapshot: string): Array<{ ref: string; role: string; label: string }> {
  const out: Array<{ ref: string; role: string; label: string }> = [];
  const seen = new Set<string>();
  for (const line of snapshot.split("\n")) {
    const match = line.match(/\[([eE]\d+)\]\s+([\w-]+)(?:\s+"([^"]*)")?/);
    if (!match) continue;
    const ref = match[1].toLowerCase();
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, role: match[2].toLowerCase(), label: (match[3] ?? "").trim() });
  }
  return out;
}

export function classifyExplorationCandidate(input: { ref: string; role: string; label: string }): ExplorationAction | null {
  const { ref, role, label } = input;
  if (!label || DENY.test(label)) return null;
  if ((role === "button" || role === "link") && PAGINATION.test(label)) {
    return { kind: "pagination", action: "click", ref, role, label };
  }
  if ((role === "checkbox" || role === "radio") && FILTER.test(label)) {
    return { kind: "filter", action: "check", ref, role, label };
  }
  // A meaningful result link is a reversible read. Navigation is validated
  // after the click; cross-origin drift is immediately abandoned.
  if (role === "link" && label.length >= 8 && label.length <= 180 && !NON_DETAIL.test(label)) {
    return { kind: "detail", action: "click", ref, role, label };
  }
  return null;
}

/** Deterministic, bounded, read-only exploration plan. */
export function planSafeExploration(snapshot: string, budget: ExplorationBudget = {}): ExplorationAction[] {
  const maxActions = budget.maxActions ?? 3;
  const limits: Record<ExplorationKind, number> = {
    filter: budget.maxFilters ?? 1,
    pagination: budget.maxPagination ?? 1,
    detail: budget.maxDetails ?? 1,
  };
  const candidates = parseExplorationCandidates(snapshot)
    .map(classifyExplorationCandidate)
    .filter((value): value is ExplorationAction => value !== null);
  const order: ExplorationKind[] = ["filter", "pagination", "detail"];
  const selected: ExplorationAction[] = [];
  for (const kind of order) {
    for (const candidate of candidates.filter((item) => item.kind === kind).slice(0, limits[kind])) {
      if (selected.length >= maxActions) return selected;
      selected.push(candidate);
    }
  }
  return selected;
}

