import { runAgentBrowser } from "./runner.js";

export interface InteractiveElement {
  index: number;
  ref: string; // "e1" (without "@")
  line: string; // original snapshot line
}

const REF_RE = /\[ref=(e\d+)\]/i;

/**
 * Get a compact interactive snapshot and parse it into deterministic indices.
 *
 * We intentionally parse the text snapshot output (not JSON) because the text
 * format is designed for agent consumption and is stable across versions.
 */
export async function snapshotInteractive(session: string): Promise<InteractiveElement[]> {
  const res = await runAgentBrowser(["--session", session, "snapshot", "-i"]);
  if (res.code !== 0) {
    throw new Error(
      `[agent-browser] snapshot failed (code=${res.code}):\n` +
      (res.stderr?.trim() ? res.stderr.trim() : res.stdout.trim()),
    );
  }

  const out: InteractiveElement[] = [];
  const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(REF_RE);
    if (!m) continue;
    out.push({ index: out.length + 1, ref: m[1], line });
  }
  return out;
}

