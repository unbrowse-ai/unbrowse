// Line-delimited JSON-RPC framing helpers. Pure, no I/O side effects.
// Day-3 seed: the simplest viable framer. Day 4-6 may add chunk-size
// caps, malformed-line tolerance, and content-length framing if upstream
// children switch to it. Deferred.

export function encodeMessage(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export function decodeLine(line: string): unknown {
  return JSON.parse(line.trim());
}

// LineReader: buffers arbitrary stdin chunks and yields complete
// newline-terminated lines via a callback. Assumes UTF-8 text mode;
// caller is responsible for setting encoding on the stream.
export class LineReader {
  private buf = "";
  private readonly onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf("\n");
    while (idx !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) {
        this.onLine(line);
      }
      idx = this.buf.indexOf("\n");
    }
  }

  // Flush any trailing un-newlined data. Children that exit without a
  // trailing newline still get their last message seen.
  flush(): void {
    const rest = this.buf.trim();
    this.buf = "";
    if (rest.length > 0) {
      this.onLine(rest);
    }
  }
}
