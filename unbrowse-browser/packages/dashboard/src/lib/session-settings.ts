/**
 * What the dashboard knows it set on a session: emulation and whether a HAR is
 * recording. Nothing can be asked of the daemon for these, so the rule is to
 * claim only what a command confirmed, and to remember it per session, because
 * the browser keeps a setting after the dashboard moves to another session.
 *
 * An entry is keyed by name and port: a new session under an old name has a new
 * daemon and starts from the browser's defaults.
 */
import type { ExecResult } from "./exec";

export type ColorScheme = "light" | "dark" | "no-preference";

export interface SessionSettings {
  device: string | null;
  colorScheme: ColorScheme;
  offline: boolean;
  harRecording: boolean;
}

export const DEFAULT_SETTINGS: SessionSettings = {
  device: null,
  colorScheme: "no-preference",
  offline: false,
  harRecording: false,
};

export type SettingsBook = Record<string, SessionSettings>;

export function settingsKey(session: string, port: number): string {
  return `${session}:${port}`;
}

export function settingsFor(book: SettingsBook, key: string): SessionSettings {
  return book[key] ?? DEFAULT_SETTINGS;
}

export function withSetting(
  book: SettingsBook,
  key: string,
  change: Partial<SessionSettings>,
): SettingsBook {
  return { ...book, [key]: { ...settingsFor(book, key), ...change } };
}

/** Why a command failed. With `--json` the reason is in stdout, not stderr. */
export function whyFailed(res: ExecResult): string {
  if (res.stderr) return res.stderr;
  try {
    const error = JSON.parse(res.stdout)?.error;
    if (typeof error === "string" && error) return error;
  } catch {
    // Not the daemon's response: there is no reason to read.
  }
  return "The command failed";
}

/**
 * Runs a command and records its setting only if it took. Returns why it
 * didn't, or "" when it did.
 */
export async function confirmSetting(
  run: () => Promise<ExecResult>,
  record: () => void,
): Promise<string> {
  const res = await run();
  if (!res.success) return whyFailed(res);
  record();
  return "";
}
