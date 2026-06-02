/**
 * @unbrowse/adopt — the universal drop-in adopter.
 *
 * One command rewrites a repo's imports from a supported upstream library to the
 * matching Unbrowse drop-in shim, IN THE SOURCE'S OWN SYNTAX (ESM `import`,
 * named imports, and CommonJS `require`). The drop-in routes a safe GET through
 * Unbrowse's resolved-route cache ($0 on a hit) and falls through to the upstream
 * on a miss — so the swap lowers cost without changing behaviour, and the upstream
 * is attributed (it remains the fallback). The output is a reviewable diff: the
 * repo owner runs `adopt` (or reviews the PR it generates) — adoption is by
 * consent, never an unsolicited dependency injection.
 *
 * This module is the pure engine (no fs); bin/adopt.mjs is the CLI wrapper.
 */

/** upstream package specifier -> the Unbrowse drop-in that mirrors its surface. */
export const DROP_IN_MAP: Record<string, string> = {
  axios: '@unbrowse/axios-shim',
  got: '@unbrowse/got-shim',
  ky: '@unbrowse/ky-shim',
  'node-fetch': '@unbrowse/node-fetch-shim',
  'cross-fetch': '@unbrowse/cross-fetch-shim',
  puppeteer: '@unbrowse/puppeteer-shim',
  playwright: '@unbrowse/playwright-shim',
  '@mendable/firecrawl-js': '@unbrowse/firecrawl-shim',
  '@browserbasehq/stagehand': '@unbrowse/stagehand-shim',
};

export interface Rewrite {
  from: string;
  to: string;
  line: number;
  before: string;
  after: string;
}

export interface AdoptResult {
  source: string;
  rewrites: Rewrite[];
}

// Build one alternation group of the supported specifiers, escaped for regex.
function specifierGroup(specs: string[]): string {
  return specs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/**
 * Rewrite every supported import/require in `source` to its drop-in.
 * Only the module specifier changes; the binding (default, named, namespace) and
 * the surrounding syntax are preserved verbatim — a true one-line swap. Unsupported
 * specifiers are left untouched. Quote style (' or ") is preserved.
 */
export function adoptSource(source: string, map: Record<string, string> = DROP_IN_MAP): AdoptResult {
  const specs = Object.keys(map);
  const group = specifierGroup(specs);

  // ESM:  import ... from '<spec>'   |   import '<spec>'   |   export ... from '<spec>'
  // also dynamic import('<spec>') and CommonJS require('<spec>')
  const patterns: RegExp[] = [
    new RegExp(`(\\bfrom\\s*)(['"])(${group})\\2`, 'g'),
    new RegExp(`(\\bimport\\s*)(['"])(${group})\\2`, 'g'), // side-effect import '<spec>'
    new RegExp(`(\\bimport\\s*\\(\\s*)(['"])(${group})\\2`, 'g'), // dynamic import('<spec>')
    new RegExp(`(\\brequire\\s*\\(\\s*)(['"])(${group})\\2`, 'g'),
  ];

  const rewrites: Rewrite[] = [];
  let out = source;

  for (const re of patterns) {
    out = out.replace(re, (full, prefix: string, quote: string, spec: string, offset: number) => {
      const to = map[spec];
      if (!to) return full;
      const line = out.slice(0, offset).split('\n').length;
      const after = `${prefix}${quote}${to}${quote}`;
      rewrites.push({ from: spec, to, line, before: full, after });
      return after;
    });
  }

  return { source: out, rewrites };
}

/** A human/PR-facing summary of what an adoption changed. */
export function summarize(results: Array<{ path: string; result: AdoptResult }>): string {
  const all = results.flatMap((r) => r.result.rewrites.map((w) => ({ path: r.path, ...w })));
  if (all.length === 0) return 'No supported imports found — nothing to adopt.';
  const byFrom = new Map<string, number>();
  for (const w of all) byFrom.set(w.from, (byFrom.get(w.from) ?? 0) + 1);
  const lines = [
    `Adopt Unbrowse drop-ins: ${all.length} import(s) across ${results.filter((r) => r.result.rewrites.length).length} file(s).`,
    '',
    'Each swap routes a safe GET through Unbrowse’s resolved-route cache ($0 on a hit) and',
    'falls through to the original library on a miss — behaviour preserved, cost lowered,',
    'upstream kept as the attributed fallback.',
    '',
    ...[...byFrom.entries()].map(([from, n]) => `  ${from} → ${DROP_IN_MAP[from]}  (${n})`),
  ];
  return lines.join('\n');
}
