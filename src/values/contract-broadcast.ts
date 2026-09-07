/**
 * contract-broadcast — reflect a /contract onto the human-facing knowledge surfaces (Notion +
 * self-hosted Outline), as two MORE tiers of the same source-of-truth chain.
 *
 * The stack tiers (IQ + emergent KV + emergent RAG, see contract-everything.ts) are the durable
 * machine record. Notion and Outline are the HUMAN reflections — the same truth, surfaced where
 * people read it. Each sink is FAIL-OPEN exactly like the stack tiers: an absent target is a
 * surfaced note, never a throw, so a deploy/bind is never blocked.
 *
 *   - Notion  → delegated to the existing /context-broadcast skill (which owns its OWN token in
 *               its config.local.json — no second credential surface in this repo). OPT-IN via
 *               CONTRACT_BROADCAST_NOTION=1 so a normal bind/gate run never writes to Notion.
 *   - Outline → a direct REST client (the /outline-api shape: documents.create), reading the
 *               token from ~/.config/outline/token; publishes only when a target collection id
 *               is configured (OUTLINE_CHAIN_COLLECTION_ID).
 *
 * No credential is required at import or build time. Tokens are read, never logged.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A contract reflected to a human surface: a title + a markdown body + a stable key. */
export interface BroadcastDoc {
  /** stable id of the underlying contract (chain/deploy/taste/reconcile). */
  id: string;
  title: string;
  /** markdown body. */
  body: string;
}

export interface SinkResult {
  ok: boolean;
  /** the surface's id for the created/updated artifact, when it landed. */
  ref?: string;
  /** never-silent reason when it did not land (absent creds / API error). */
  note?: string;
}

export interface BroadcastOutcome {
  notion: SinkResult;
  outline: SinkResult;
}

function envOrFile(envName: string, ...filePath: string[]): string | undefined {
  const e = (typeof process !== "undefined" ? process.env?.[envName] : undefined)?.trim();
  if (e) return e;
  try {
    const v = readFileSync(join(homedir(), ...filePath), "utf8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

function timeoutMs(): number {
  const n = Number(typeof process !== "undefined" ? process.env?.CONTRACT_BROADCAST_TIMEOUT_MS : undefined);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

/**
 * Reflect a contract into Notion by delegating to the /context-broadcast skill (which owns its own
 * token + Notion DB config — no credential surface here). OPT-IN: a no-op note unless
 * CONTRACT_BROADCAST_NOTION=1, so a normal bind/gate run never writes to Notion. The contract's
 * title+id rides in as the broadcast `--note`. Fail-open: a missing script / python / non-zero
 * exit is a surfaced note, never a throw.
 */
export async function reflectToNotion(doc: BroadcastDoc): Promise<SinkResult> {
  const enabled = (typeof process !== "undefined" ? process.env?.CONTRACT_BROADCAST_NOTION : undefined)?.trim();
  if (enabled !== "1") {
    return { ok: false, note: "notion: opt-in CONTRACT_BROADCAST_NOTION=1 via /context-broadcast — skipped" };
  }
  const script =
    (typeof process !== "undefined" ? process.env?.CONTEXT_BROADCAST_SCRIPT : undefined)?.trim() ||
    join(homedir(), ".claude", "skills", "context-broadcast", "scripts", "broadcast.py");
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [script, "--note", `${doc.title} — ${doc.id}`],
      { timeout: timeoutMs(), encoding: "utf8" },
    );
    // The skill prints the Notion page / contract refs; surface the last non-empty line.
    const ref = stdout.trim().split("\n").filter(Boolean).pop();
    return { ok: true, ref };
  } catch (e) {
    return { ok: false, note: `notion (/context-broadcast): ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Reflect a contract into self-hosted Outline (a document in the configured collection). Fail-open:
 * returns a note when the token / baseurl / OUTLINE_CHAIN_COLLECTION_ID is absent. Uses the same
 * REST shape as /outline-api (documents.create), reading ~/.config/outline/{token,baseurl}.
 */
export async function reflectToOutline(doc: BroadcastDoc): Promise<SinkResult> {
  const token = envOrFile("OUTLINE_TOKEN", ".config", "outline", "token");
  const base = (envOrFile("OUTLINE_BASEURL", ".config", "outline", "baseurl") ?? "").replace(/\/$/, "");
  const collectionId = (typeof process !== "undefined" ? process.env?.OUTLINE_CHAIN_COLLECTION_ID : undefined)?.trim();
  if (!token) return { ok: false, note: "outline: token absent (~/.config/outline/token) — skipped" };
  if (!base) return { ok: false, note: "outline: baseurl absent — skipped" };
  if (!collectionId) return { ok: false, note: "outline: OUTLINE_CHAIN_COLLECTION_ID absent — skipped" };
  try {
    const res = await fetch(`${base}/api/documents.create`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ collectionId, title: doc.title, text: doc.body, publish: true }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) return { ok: false, note: `outline: ${res.status} ${(await res.text()).slice(0, 160)}` };
    const id = ((await res.json()) as { data?: { id?: string } }).data?.id;
    return { ok: true, ref: id };
  } catch (e) {
    return { ok: false, note: `outline: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Reflect a contract onto both human surfaces. Fail-open per sink (independent; one absent sink
 *  never blocks the other or the caller). */
export async function broadcastContract(doc: BroadcastDoc): Promise<BroadcastOutcome> {
  const [notion, outline] = await Promise.all([reflectToNotion(doc), reflectToOutline(doc)]);
  return { notion, outline };
}

/** Notes for the surfaces that did NOT land — so the recorder can surface them, never silent. */
export function broadcastNotes(o: BroadcastOutcome): string[] {
  return [o.notion.note, o.outline.note].filter((n): n is string => Boolean(n));
}
