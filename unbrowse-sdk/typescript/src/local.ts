// Node.js only (`unbrowse/local`): where the node on this machine keeps what its owner reads. A page in a
// browser can't read these files; it reaches the node through a proxy that does.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT } from "./generated.js";

/** The node's own directory: `UNBROWSE_HOME`, else `~/.unbrowse`. */
export function nodeHome(): string {
  return process.env.UNBROWSE_HOME || join(homedir(), ".unbrowse");
}

/**
 * The owner's token, read fresh: the node writes a new one (mode 0600) every time it starts, so a token read once goes
 * stale on the next restart. `undefined` when the node has never run here.
 */
export function ownerToken(home = nodeHome()): string | undefined {
  try {
    return readFileSync(join(home, "owner.token"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The node's port: `UNBROWSE_PORT`, else `api_port` in its settings, else `DEFAULT_PORT`. */
export function nodePort(home = nodeHome()): number {
  const named = Number(process.env.UNBROWSE_PORT);
  if (Number.isInteger(named) && named > 0 && named < 65536) return named;
  try {
    const port = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).api_port;
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/** The node's address on this machine: `UNBROWSE_NODE`, else 127.0.0.1 on its port. */
export function nodeAddress(home = nodeHome()): string {
  return process.env.UNBROWSE_NODE || `http://127.0.0.1:${nodePort(home)}`;
}
