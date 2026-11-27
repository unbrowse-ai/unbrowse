// Node.js only: the node on this machine, started for a client when none is running (`Unbrowse.start`, `autoStart`).
// The node needs no browser for this: it serves search, calls and whoami without one, and fetches its browser only when
// a goal needs it (or never, when its owner says so).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { binDir, platformPackage } from "./cli.js";
import { UnbrowseNode, type Started, type UnbrowseNodeOptions } from "./client.js";
import { env, errorFor, trimBase } from "./http.js";
import { nodeHome, nodePort } from "./local.js";

export type StartOptions = Omit<UnbrowseNodeOptions, "autoStart"> & {
  /** The node's home (`UNBROWSE_HOME`) for a node this starts. Defaults to the environment's, else `~/.unbrowse`. */
  home?: string;
  /** The port a node this starts listens on (`UNBROWSE_PORT`). Defaults to the home's `api_port`, else 7788. */
  port?: number;
  /** The `unbrowse-node` program. Defaults to `UNBROWSE_BIN`'s, else the one the platform package brought. */
  program?: string;
  /** How long to wait for a node this starts to answer and give a token, in ms. Defaults to 60 s. */
  readyTimeoutMs?: number;
  /** More environment for a node this starts (`UNBROWSE_BROWSER`, `UNBROWSE_SYSTEM_BROWSERS`, ...). */
  env?: Record<string, string | undefined>;
  /** Where a node this starts writes its log: `"ignore"` (the default: its last lines are kept for errors) or `"inherit"`. */
  output?: "ignore" | "inherit";
};

/** The `unbrowse-node` program on this machine: `program`, else `UNBROWSE_BIN`'s, else the platform package's. */
export function nodeProgram(program?: string): string | undefined {
  const name = process.platform === "win32" ? "unbrowse-node.exe" : "unbrowse-node";
  const dir = binDir();
  return [program, dir && join(dir, name)].find((p): p is string => !!p && existsSync(p));
}

/** Whether anything answers HTTP at `base`. */
async function answers(base: string, f: typeof fetch): Promise<boolean> {
  try {
    const r = await f(`${base}/v1/node/proof?challenge=${"00".repeat(32)}`, { signal: AbortSignal.timeout(2_000) });
    await r.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The last lines a node this started wrote, for an error that says why it didn't come up. */
function tail(child: ChildProcess): () => string {
  const lines: string[] = [];
  const keep = (b: Buffer) => {
    lines.push(...b.toString("utf8").split("\n").filter((l) => l.trim()));
    lines.splice(0, Math.max(0, lines.length - 20));
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  return () => lines.slice(-8).join("\n");
}

/** Runs `unbrowse-node agent token` until the node has made its first agent key, and answers its token. */
async function agentToken(program: string, nodeEnv: NodeJS.ProcessEnv, deadline: number): Promise<string> {
  for (;;) {
    const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(program, ["agent", "token"], { env: nodeEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (err += b));
      p.on("error", (e) => resolve({ code: -1, out: "", err: e.message }));
      p.on("close", (code) => resolve({ code, out, err }));
    });
    const token = out.trim();
    if (code === 0 && token) return token;
    // 3: no agent key yet; the node makes its first once its key is open.
    if (code !== 3 || Date.now() > deadline) {
      throw errorFor(`couldn't get an agent token from the node: ${err.trim() || `unbrowse-node agent token exited ${code}`}`, 401, "unauthorized");
    }
    await sleep(500);
  }
}

/** Starts `program` with no window and answers how to stop it. */
function launch(program: string, nodeEnv: NodeJS.ProcessEnv, output: "ignore" | "inherit"): { said: () => string; exited: () => boolean; started: Started } {
  const child = spawn(program, [], { env: nodeEnv, stdio: output === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"] });
  const said = tail(child);
  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));
  // A script that ends without close() doesn't leave the node it started running.
  const onExit = () => {
    if (!exited) child.kill();
  };
  process.once("exit", onExit);
  // Nor does the node keep the script alive.
  child.unref();
  for (const s of [child.stdout, child.stderr]) (s as unknown as { unref?: () => void } | null)?.unref?.();
  const stop = async () => {
    process.removeListener("exit", onExit);
    if (exited) return;
    const gone = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGTERM");
    const late = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await gone;
    clearTimeout(late);
  };
  return { said, exited: () => exited, started: { stop, exited: () => exited } };
}

/**
 * Finds the node a client talks to, starting one when none answers: its address, a token for it, and the process to
 * stop when this started it. @internal
 */
export async function bring(opts: StartOptions = {}): Promise<{ baseUrl: string; token?: string; started: Started | null }> {
  const home = opts.home ?? nodeHome();
  const port = opts.port ?? nodePort(home);
  const baseUrl = trimBase(opts.baseUrl ?? (opts.home || opts.port ? `http://127.0.0.1:${port}` : env("UNBROWSE_NODE") ?? `http://127.0.0.1:${port}`));
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 60_000);
  const program = nodeProgram(opts.program);
  const nodeEnv: NodeJS.ProcessEnv = { ...process.env, UNBROWSE_HOME: home, ...(opts.port && { UNBROWSE_PORT: String(opts.port) }), ...opts.env };
  let started: Started | null = null;
  if (!(await answers(baseUrl, f))) {
    if (!program) {
      throw errorFor(
        `no node answers at ${baseUrl}, and there's no unbrowse-node here to start: install Unbrowse (npm install -g unbrowse, or pip install unbrowse; ${platformPackage()} brings the node for this machine), or set UNBROWSE_BIN to the folder that holds unbrowse-node`,
        0,
        "unreachable",
      );
    }
    const l = launch(program, nodeEnv, opts.output ?? "ignore");
    started = l.started;
    while (!(await answers(baseUrl, f))) {
      const gone = l.exited();
      if (gone && (await answers(baseUrl, f))) break;
      if (gone || Date.now() > deadline) {
        await l.started.stop();
        const why = l.said();
        throw errorFor(`the node at ${program} didn't come up at ${baseUrl}${why ? `:\n${why}` : ""}`, 0, "unreachable");
      }
      await sleep(250);
    }
    // Two starters: this one's node lost the port and exited, and what answers is the other's, not this one's to stop.
    if (l.exited()) {
      await l.started.stop();
      started = null;
    }
  }
  // A token the caller named is the one used: `token`, else UNBROWSE_AGENT_TOKEN. Only a node this process started gives
  // its own (its first key), and only when none was named: nothing else in the environment, a home included, stands in
  // for the caller's choice.
  let token = opts.token ?? env("UNBROWSE_AGENT_TOKEN");
  if (!token && started && program) {
    try {
      token = await agentToken(program, nodeEnv, deadline);
    } catch (e) {
      await started.stop();
      throw e;
    }
  }
  if (!token) {
    const found = started ? "" : ` A node was running at ${baseUrl} already, and only a node this process starts gives its own key: name one (\`unbrowse agent token\` prints the node's first key).`;
    throw errorFor(`no agent token: pass { token } or set UNBROWSE_AGENT_TOKEN (\`unbrowse agent token\` prints one; \`unbrowse agent new <name>\` makes a key of the agent's own).${found}`, 401, "unauthorized");
  }
  return { baseUrl, token, started };
}

/** The node on this machine, started when none is running (`Unbrowse.start`). */
export async function start(opts: StartOptions = {}): Promise<UnbrowseNode> {
  const found = await bring(opts);
  const node = new UnbrowseNode({ ...opts, baseUrl: found.baseUrl, token: found.token });
  node.adopt(found.baseUrl, found.token, found.started, opts);
  return node;
}
