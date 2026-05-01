/**
 * Phase 8.2 — Interactive contribution-mode prompt for `unbrowse setup` and
 * the standalone `unbrowse mode` command.
 *
 * Three options:
 *   [1] Private (default)  — captures cached locally, never published
 *   [2] Share              — pointers contributed to the marketplace
 *   [3] Share + earn       — share + opt into x402 micropayment rev-share
 *
 * `force=true` (used by `unbrowse mode`) re-prompts even if a previous choice
 * was recorded. Default `force=false` (used by `unbrowse setup`) skips the
 * prompt when the user has already chosen.
 *
 * Non-interactive environments (no TTY, UNBROWSE_NON_INTERACTIVE=1, or test
 * runs) skip the prompt and leave the existing config untouched. Tests inject
 * `readChoice` to drive the flow deterministically.
 */

import { createInterface } from "node:readline";
import {
  getContributionConfig,
  setContributionConfig,
  decrementNoticeCounter,
  type ContributionConfig,
} from "./config/contribution.js";

export type ContributionChoice = 1 | 2 | 3;

export type ChoiceReader = (allowed: ContributionChoice[], dflt: ContributionChoice) => Promise<ContributionChoice>;

/** Default reader — uses node:readline. Stubbed in tests. */
async function defaultReadChoice(
  allowed: ContributionChoice[],
  dflt: ContributionChoice,
): Promise<ContributionChoice> {
  const isInteractive = !!process.stdin.isTTY && !!process.stdout.isTTY && process.env.UNBROWSE_NON_INTERACTIVE !== "1";
  if (!isInteractive) return dflt;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Choice [${dflt}]: `, resolve);
      });
      const trimmed = answer.trim();
      if (!trimmed) return dflt;
      const n = parseInt(trimmed, 10);
      if (allowed.includes(n as ContributionChoice)) return n as ContributionChoice;
      console.log(`Please enter ${allowed.join(", ")} (or press Enter for ${dflt}).`);
    }
  } finally {
    rl.close();
  }
}

export interface PromptContributionModeOptions {
  /** Re-prompt even if a previous choice was recorded. */
  force?: boolean;
  /** Test seam — inject deterministic choice. */
  readChoice?: ChoiceReader;
  /** Test seam — inject log sink (defaults to console.log). */
  log?: (msg: string) => void;
}

/**
 * Returns the chosen option (1/2/3) or `null` when skipped because the user
 * already picked one and `force=false`.
 */
export async function promptContributionMode(
  opts: PromptContributionModeOptions = {},
): Promise<ContributionChoice | null> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const cfg: ContributionConfig = getContributionConfig();
  if (!opts.force && cfg.contribution.set_via && cfg.contribution.set_via !== "default") {
    return null;
  }

  log("");
  log("How do you want unbrowse to handle the routes you discover?");
  log("");
  log("  [1] Private (default)  — cache locally, never publish");
  log("  [2] Share              — contribute pointers to the marketplace");
  log("  [3] Share + earn       — contribute and add a wallet for x402 rev-share");
  log("");

  const reader = opts.readChoice ?? defaultReadChoice;
  const choice = await reader([1, 2, 3], 1);
  const set_via = opts.force ? "mode-command" : "setup-prompt";

  if (choice === 1) {
    setContributionConfig({
      contribution: { share_pointers: false, set_via },
      rev_share: { opted_in: false },
    });
    log("Private mode set. Run `unbrowse mode` anytime to change.");
  } else if (choice === 2) {
    setContributionConfig({
      contribution: { share_pointers: true, set_via },
      rev_share: { opted_in: false },
    });
    log("Sharing pointers enabled. Add a wallet via `unbrowse mode` to opt into rev-share.");
  } else {
    setContributionConfig({
      contribution: { share_pointers: true, set_via },
      rev_share: { opted_in: true },
    });
    log("Sharing + rev-share enabled. Run `unbrowse wallet` to add your wallet for payouts.");
  }

  return choice;
}

/**
 * Print the existing-user migration notice (once per invocation, capped at 5
 * total shows). Called from cmdResolve / cmdExecute / cmdGo / etc.
 *
 * Returns `true` when a notice was printed.
 */
export function maybeShowContributionNotice(): boolean {
  const cfg = getContributionConfig();
  if (cfg.contribution.set_via !== "default") return false;
  const remaining = cfg.notice_shown_count ?? 0;
  if (remaining <= 0) return false;
  process.stderr.write(
    "[unbrowse] contribution mode is now `private` by default — captures stay on your machine.\n" +
    `[unbrowse] run \`unbrowse mode\` to opt into sharing + rev-share. (notice will repeat ${remaining - 1} more time${remaining - 1 === 1 ? "" : "s"})\n`,
  );
  decrementNoticeCounter();
  return true;
}
