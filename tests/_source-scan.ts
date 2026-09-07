/**
 * Reading source as TEXT, soundly enough to count call sites.
 *
 * Several signals in this suite work by scanning source for an identifier, and
 * they must not count prose: a doc comment naming `obscuraBackendSelected()`
 * once muted a drift signal by flagging a file whose only mention was in a
 * comment.
 *
 * The obvious fix — `src.replace(/\/\*[\s\S]*?\*\//g, "")` — is UNSOUND, and
 * measurably so. A `/*` inside a string or regex literal opens a comment that
 * the stripper closes at the next `*​/`, thousands of lines later. Measured on
 * this repo:
 *
 *     src/orchestrator/index.ts   9,153 lines -> 6,970 after the naive strip
 *                                 121,684 chars (28%) silently eaten
 *
 * A real call site at line 5,627 sat inside the eaten region, so a signal built
 * on that strip reported the file as having NO call sites at all. It was not
 * detecting anything; it was reading a hole. (The existing
 * obscuraBackendSelected drift check saw all 7 of its sites anyway — by luck of
 * where the hole fell, not by construction.)
 *
 * Line-based filtering cannot open an unterminated region, so its worst case is
 * bounded at one line: it drops full-line comments and doc-comment continuation
 * lines, and keeps everything else. An identifier in a trailing `// ...` comment
 * on a code line still counts — accepted deliberately, because over-counting
 * makes a pinned inventory fail loudly, while under-counting makes it pass
 * blindly. Loud is the safe direction for a signal.
 */

/** Source with full-line comments removed. Never removes more than it is given. */
export function codeLinesOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/** How many times `name` is CALLED in real code (not prose). */
export function countCalls(src: string, name: string): number {
  const re = new RegExp(`\\b${name}\\(`, "g");
  return (codeLinesOnly(src).match(re) ?? []).length;
}
