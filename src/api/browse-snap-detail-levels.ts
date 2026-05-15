/**
 * Snap detail-level trimming for the `unbrowse_snap` MCP tool.
 *
 * The Kuri a11y tree returned by `kuri.snapshot(tabId, filter)` is a plain
 * text string where each interactive node is prefixed with `[eN]`. A real
 * snapshot can run into tens of thousands of characters on a list-heavy
 * page (Wikipedia, HN, GitHub repo). Three detail levels let the calling
 * agent ask for only what it needs:
 *
 *   - "minimal"  : a tiny header with root_aria, current_url, page_title,
 *                  interactive_count, landmark_count. Target < 1024 chars
 *                  wire size when JSON-encoded.
 *   - "summary"  : minimal + a per-role landmark count breakdown + an
 *                  error_state hint when an alert role is present.
 *                  Target < 8192 chars wire size.
 *   - "full"     : the unmodified snapshot string. No regression vs the
 *                  pre-AC4 behavior.
 *
 * Default is "minimal". Most agentic loops want a small probe and only
 * ask for the full tree when they're about to interact.
 */

export type SnapDetailLevel = 'minimal' | 'summary' | 'full';

export interface SnapDetailContext {
  current_url?: string | null;
  page_title?: string | null;
}

export interface SnapMinimalResult {
  detail_level: 'minimal';
  root_aria: string;
  current_url: string;
  page_title: string;
  interactive_count: number;
  landmark_count: number;
}

export interface SnapLandmark {
  role: string;
  name: string;
  count: number;
}

export interface SnapSummaryResult {
  detail_level: 'summary';
  root_aria: string;
  current_url: string;
  page_title: string;
  interactive_count: number;
  landmark_count: number;
  landmarks: SnapLandmark[];
  error_state?: string;
}

export interface SnapFullResult {
  detail_level: 'full';
  snapshot: string;
  current_url: string;
  page_title: string;
}

export type SnapDetailResult = SnapMinimalResult | SnapSummaryResult | SnapFullResult;

// Roles the WAI-ARIA spec calls "landmark" or document-structural. Used
// for the summary breakdown. We don't list "main"/"banner" as banned:
// every site uses them and that's the point.
const LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'search',
  'form',
  'region',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
]);

// Roles that signal an error/blocker on the page.
const ERROR_ROLES = new Set(['alert', 'alertdialog']);

interface ParsedSnapshot {
  root: string;
  interactiveCount: number;
  landmarks: SnapLandmark[];
  errorState?: string;
}

/**
 * Parse the Kuri snapshot text and pull out:
 *  - the root accessibility line (typically the first `[eN]` row)
 *  - the total count of `[eN]` interactive refs
 *  - a frequency-by-role tally of landmark-shaped lines
 *  - an error_state hint when an `alert` / `alertdialog` role is named
 *
 * The parser tolerates malformed input. If the snapshot is empty or
 * doesn't look like the expected `[eN] role name` shape, every field
 * falls back to a safe default (empty string, zero, empty array).
 */
function parseSnapshot(snapshot: string): ParsedSnapshot {
  if (typeof snapshot !== 'string' || snapshot.length === 0) {
    return { root: '', interactiveCount: 0, landmarks: [] };
  }

  const lines = snapshot.split('\n');
  let root = '';
  let interactiveCount = 0;
  const roleCounts = new Map<string, { name: string; count: number }>();
  let errorState: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    // Match `[eN] role "name"` or `[eN] role name` shape.
    const refMatch = trimmed.match(/^\[e(\d+)\]\s*(\S+)?\s*(.*)$/);
    if (!refMatch) continue;
    interactiveCount++;

    const refNum = Number(refMatch[1]);
    const role = (refMatch[2] ?? '').toLowerCase();
    const rawName = (refMatch[3] ?? '').trim();
    // Strip surrounding quotes when present.
    const name = rawName.replace(/^"(.*)"$/, '$1');

    if (refNum === 0 && root === '') {
      root = trimmed;
    }

    if (role && LANDMARK_ROLES.has(role)) {
      const existing = roleCounts.get(role);
      if (existing) {
        existing.count++;
        if (!existing.name && name) existing.name = name;
      } else {
        roleCounts.set(role, { name, count: 1 });
      }
    }

    if (role && ERROR_ROLES.has(role) && !errorState) {
      errorState = name || role;
    }
  }

  const landmarks: SnapLandmark[] = Array.from(roleCounts.entries()).map(
    ([role, { name, count }]) => ({ role, name, count }),
  );

  return { root, interactiveCount, landmarks, errorState };
}

/**
 * Truncate a string to `max` chars, suffixing with `...` when cut.
 */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return value.slice(0, max - 3) + '...';
}

/**
 * Apply a detail-level trim to a Kuri a11y snapshot string.
 *
 * `level === undefined` is treated as `"minimal"`.
 *
 * Caller is responsible for passing `current_url` and `page_title` from
 * the live browse session; the helper does not call back into the
 * broker.
 */
export function applySnapDetailLevel(
  snapshot: string,
  level: SnapDetailLevel | undefined,
  context: SnapDetailContext,
): SnapDetailResult {
  const resolved: SnapDetailLevel = level ?? 'minimal';
  const current_url = clip(String(context.current_url ?? ''), 256);
  const page_title = clip(String(context.page_title ?? ''), 256);

  if (resolved === 'full') {
    return {
      detail_level: 'full',
      snapshot,
      current_url,
      page_title,
    };
  }

  const parsed = parseSnapshot(snapshot);
  // Cap the root_aria line so a runaway label can't blow the minimal cap.
  const root_aria = clip(parsed.root, 256);

  if (resolved === 'summary') {
    // Cap landmarks list at 24 entries with name clipped at 64 chars
    // each so the wire stays well under 8192.
    const landmarks = parsed.landmarks.slice(0, 24).map((l) => ({
      role: l.role,
      name: clip(l.name, 64),
      count: l.count,
    }));
    const out: SnapSummaryResult = {
      detail_level: 'summary',
      root_aria,
      current_url,
      page_title,
      interactive_count: parsed.interactiveCount,
      landmark_count: parsed.landmarks.length,
      landmarks,
    };
    if (parsed.errorState) {
      out.error_state = clip(parsed.errorState, 160);
    }
    return out;
  }

  // minimal (default)
  return {
    detail_level: 'minimal',
    root_aria,
    current_url,
    page_title,
    interactive_count: parsed.interactiveCount,
    landmark_count: parsed.landmarks.length,
  };
}
