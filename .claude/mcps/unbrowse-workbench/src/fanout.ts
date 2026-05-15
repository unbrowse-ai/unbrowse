// Per-request fan-out across CANDIDATE + BASELINE. Maintains an
// awaiter map keyed on JSON-RPC request id. Both children receive the
// request verbatim; both responses are awaited fully via Promise.all.

import type { ChildHandle } from "./spawn.ts";
import { encodeMessage, decodeLine } from "./framing.ts";

export interface SideMeta {
  ms: number;
  bytes: number;
}

export interface FanoutResult {
  liveResponse: Record<string, unknown>;
  candidate: SideMeta;
  baseline: SideMeta;
  candidateResponse: Record<string, unknown> | null;
  baselineResponse: Record<string, unknown> | null;
}

type Awaiters = Map<
  string | number,
  {
    resolve: (msg: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    started: number;
  }
>;

export class Fanout {
  private readonly candidateAwaiters: Awaiters = new Map();
  private readonly baselineAwaiters: Awaiters = new Map();

  constructor(
    private readonly candidate: ChildHandle,
    private readonly baseline: ChildHandle | null,
  ) {
    candidate.onMessage((line) => this.routeResponse(this.candidateAwaiters, line));
    if (baseline) {
      baseline.onMessage((line) => this.routeResponse(this.baselineAwaiters, line));
    }
  }

  private routeResponse(awaiters: Awaiters, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = decodeLine(line) as Record<string, unknown>;
    } catch (err) {
      process.stderr.write(`[workbench] undecodable line: ${line}\n`);
      return;
    }
    const id = msg["id"];
    if (id === undefined || id === null) {
      // Notification or unsolicited; ignore for fanout. Day 4 will
      // decide how to mirror notifications (progress, log).
      return;
    }
    const key = id as string | number;
    const entry = awaiters.get(key);
    if (!entry) {
      // Late or duplicate; drop.
      return;
    }
    awaiters.delete(key);
    entry.resolve(msg);
  }

  // Fire a request to both upstreams and await both responses. The
  // returned promise resolves once BOTH sides answer (or both reject).
  // The liveSide parameter selects which response is treated as
  // authoritative for the parent's stdout.
  async fanout(
    request: Record<string, unknown>,
    liveSide: "candidate" | "baseline",
  ): Promise<FanoutResult> {
    const id = request["id"];
    if (id === undefined || id === null) {
      throw new Error("fanout requires a request with an id");
    }
    const key = id as string | number;
    const line = encodeMessage(request);

    const candidatePromise = this.awaitOn(this.candidateAwaiters, key, () =>
      this.candidate.send(line),
    );
    const baselinePromise = this.baseline
      ? this.awaitOn(this.baselineAwaiters, key, () => this.baseline!.send(line))
      : Promise.resolve<{
          msg: Record<string, unknown> | null;
          ms: number;
          bytes: number;
        }>({ msg: null, ms: 0, bytes: 0 });

    const [cand, base] = await Promise.all([candidatePromise, baselinePromise]);

    const liveResponse =
      liveSide === "candidate"
        ? cand.msg ?? this.fallbackError(request, "candidate side empty")
        : base.msg ?? this.fallbackError(request, "baseline side empty");

    return {
      liveResponse,
      candidate: { ms: cand.ms, bytes: cand.bytes },
      baseline: { ms: base.ms, bytes: base.bytes },
      candidateResponse: cand.msg,
      baselineResponse: base.msg,
    };
  }

  private awaitOn(
    awaiters: Awaiters,
    key: string | number,
    send: () => void,
  ): Promise<{ msg: Record<string, unknown> | null; ms: number; bytes: number }> {
    return new Promise((resolve) => {
      const started = Date.now();
      awaiters.set(key, {
        started,
        resolve: (msg) => {
          const ms = Date.now() - started;
          const bytes = Buffer.byteLength(JSON.stringify(msg), "utf8");
          resolve({ msg, ms, bytes });
        },
        reject: (_err) => {
          resolve({ msg: null, ms: Date.now() - started, bytes: 0 });
        },
      });
      try {
        send();
      } catch (err) {
        awaiters.delete(key);
        resolve({ msg: null, ms: Date.now() - started, bytes: 0 });
      }
    });
  }

  private fallbackError(
    request: Record<string, unknown>,
    reason: string,
  ): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      id: request["id"],
      error: {
        code: -32000,
        message: `unbrowse-workbench: ${reason}`,
      },
    };
  }
}
