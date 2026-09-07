/**
 * React Server Components wire format detection and parsing.
 * RSC payloads use newline-delimited format: "0:[\"$\",\"div\",null,{}]"
 */

/** Detect if a response body is an RSC wire format payload */
export function isRscPayload(body: string): boolean {
  if (!body || body.length < 3) return false;
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const rscLines = lines.filter((l) => /^\d+:/.test(l));
  return rscLines.length / lines.length >= 0.5;
}

/** Parse RSC wire format into individual chunks */
export function parseRscPayload(
  body: string,
): Array<{ id: string; data: unknown }> {
  const results: Array<{ id: string; data: unknown }> = [];
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const id = line.slice(0, colonIdx);
    if (!/^\d+$/.test(id)) continue;
    const rest = line.slice(colonIdx + 1);
    try {
      results.push({ id, data: JSON.parse(rest) });
    } catch {
      results.push({ id, data: rest });
    }
  }
  return results;
}

/** Extract URLs embedded in RSC payload for endpoint discovery */
export function extractRscDataEndpoints(body: string): string[] {
  const urls: string[] = [];
  const urlPattern = /https?:\/\/[^\s"'\\)]+/g;
  let match;
  while ((match = urlPattern.exec(body)) !== null) {
    urls.push(match[0]);
  }
  return [...new Set(urls)];
}
