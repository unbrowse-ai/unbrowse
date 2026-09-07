/**
 * attest — OS-native user-presence attestation gate.
 *
 * The pass (`pass.ts`) authorizes a credential open; this module is the
 * SECOND witness: "is a human actually at the keyboard right now?" This is
 * the Touch ID / Windows Hello / polkit layer — the OS-native biometric or
 * PIN prompt — that fires BEFORE the wallet derives the seal key and
 * decrypts the secret.
 *
 * Per-OS implementations:
 *
 *   darwin  → Swift helper binary calling LAContext.evaluatePolicy(
 *             .deviceOwnerAuthenticationWithBiometrics, reason:). Falls
 *             back to the keychain password prompt if the Swift helper is
 *             not built / biometry unavailable.
 *   win32   → PowerShell `UserConsentVerifier.RequestVerificationAsync`
 *             (Windows Hello). Falls back to a stdin prompt.
 *   linux   → `pkcheck` (polkit). Falls back to a stdin prompt.
 *   other   → stdin prompt (no biometric).
 *
 * Attestation is cached per-process for a TTL (default 5 min) so the user
 * is not bombarded with Touch ID prompts on every resolve.
 * `UNBROWSE_PRESENCE_TTL_SEC` overrides the TTL; `UNBROWSE_PRESENCE=off`
 * disables the gate entirely (CI / headless).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { execSync, execFileSync } from "node:child_process";

const ATTEST_TTL_DEFAULT_SEC = 5 * 60;
const ATTEST_HELPER_PATH = join(homedir(), ".unbrowse", "bin", "unbrowse-attest");

let cachedAttestation: { at: number } | null = null;

export interface Attestation {
  ok: boolean;
  method: "touch_id" | "windows_hello" | "polkit" | "keychain_password" | "stdin" | "disabled" | "unavailable" | "cached";
  reason: string;
}

function ttlSec(): number {
  const v = process.env.UNBROWSE_PRESENCE_TTL_SEC;
  if (v && /^\d+$/.test(v)) return parseInt(v, 10);
  return ATTEST_TTL_DEFAULT_SEC;
}

function attestationDisabled(): boolean {
  return process.env.UNBROWSE_PRESENCE === "off";
}

// ─── macOS Touch ID via Swift helper ─────────────────────────────────────────

const SWIFT_SOURCE = `import Foundation
import LocalAuthentication

let ctx = LAContext()
var error: NSError?
let reason = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "unbrowse requires your Touch ID to unlock a credential"
if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
    let sem = DispatchSemaphore(value: 0)
    ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, err in
        if ok { print("OK"); sem.signal() }
        else { print("DENIED: \\(err?.localizedDescription ?? "unknown")"); sem.signal() }
    }
    sem.wait()
} else {
    // No biometry available — fall back to device-owner auth (password)
    if ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
        let sem = DispatchSemaphore(value: 0)
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, err in
            if ok { print("OK"); sem.signal() }
            else { print("DENIED: \\(err?.localizedDescription ?? "unknown")"); sem.signal() }
        }
        sem.wait()
    } else {
        print("UNAVAILABLE: \\(error?.localizedDescription ?? "no biometric or password auth")")
    }
}
`;

function ensureSwiftHelperBuilt(): string | null {
  if (platform() !== "darwin") return null;
  if (existsSync(ATTEST_HELPER_PATH)) return ATTEST_HELPER_PATH;
  try {
    const dir = dirname(ATTEST_HELPER_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
    const srcPath = `${ATTEST_HELPER_PATH}.swift`;
    writeFileSync(srcPath, SWIFT_SOURCE, { mode: 0o600 });
    execSync(`swiftc -O -o "${ATTEST_HELPER_PATH}" "${srcPath}" 2>&1`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    if (!existsSync(ATTEST_HELPER_PATH)) return null;
    return ATTEST_HELPER_PATH;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[attest] swift helper build failed: ${msg}\n`);
    return null;
  }
}

function attestTouchId(reason: string): Attestation {
  const helper = ensureSwiftHelperBuilt();
  if (!helper) {
    return { ok: false, method: "unavailable", reason: "swift helper unavailable, build failed" };
  }
  try {
    const out = execFileSync(helper, [reason], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (out === "OK") {
      return { ok: true, method: "touch_id", reason: "Touch ID verified" };
    }
    return { ok: false, method: "touch_id", reason: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, method: "touch_id", reason: `helper exec failed: ${msg}` };
  }
}

// ─── Windows Hello via PowerShell ────────────────────────────────────────────

function attestWindowsHello(reason: string): Attestation {
  try {
    const ps = `
$async = Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime
$verifier = ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync("${reason.replace(/"/g, "'")}"))
while ($verifier.Status -eq 0) { Start-Sleep -Milliseconds 50 }
if ($verifier.Status -eq 1) { "OK" } else { "DENIED" }
`;
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "OK") return { ok: true, method: "windows_hello", reason: "Windows Hello verified" };
    return { ok: false, method: "windows_hello", reason: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, method: "windows_hello", reason: `powershell failed: ${msg}` };
  }
}

// ─── Linux polkit ────────────────────────────────────────────────────────────

function attestPolkit(reason: string): Attestation {
  try {
    execFileSync("pkcheck", ["--process", String(process.pid), "--allow-user-interaction"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, method: "polkit", reason: "polkit verified" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, method: "polkit", reason: `pkcheck failed: ${msg}` };
  }
}

// ─── stdin fallback ──────────────────────────────────────────────────────────

function attestStdin(reason: string): Attestation {
  process.stderr.write(`\n[attest] ${reason}\nPress ENTER to approve, Ctrl-C to deny: `);
  try {
    const buf = Buffer.alloc(16);
    const fd = require("node:fs").openSync("/dev/tty", "r");
    require("node:fs").readSync(fd, buf, 0, 16, 0);
    require("node:fs").closeSync(fd);
    return { ok: true, method: "stdin", reason: "user approved via stdin" };
  } catch (err) {
    return { ok: false, method: "stdin", reason: `stdin failed: ${(err as Error).message}` };
  }
}

// ─── the public gate ─────────────────────────────────────────────────────────

export function attest(reason: string, opts?: { force?: boolean }): Attestation {
  if (attestationDisabled()) {
    return { ok: true, method: "disabled", reason: "UNBROWSE_PRESENCE=off" };
  }
  // TTL cache (unless force)
  if (!opts?.force && cachedAttestation) {
    const age = (Date.now() - cachedAttestation.at) / 1000;
    if (age < ttlSec()) {
      return { ok: true, method: "cached", reason: `attested ${Math.round(age)}s ago (within TTL ${ttlSec()}s)` };
    }
  }

  const p = platform();
  let result: Attestation;
  if (p === "darwin") {
    result = attestTouchId(reason);
    if (!result.ok) {
      // Fall back to stdin so headless / no-biometry macOS still works
      result = attestStdin(reason);
    }
  } else if (p === "win32") {
    result = attestWindowsHello(reason);
    if (!result.ok) result = attestStdin(reason);
  } else if (p === "linux") {
    result = attestPolkit(reason);
    if (!result.ok) result = attestStdin(reason);
  } else {
    result = attestStdin(reason);
  }

  if (result.ok) {
    cachedAttestation = { at: Date.now() };
  }
  return result;
}

/** Clear the TTL cache — next attest() will re-prompt. */
export function clearAttestation(): void {
  cachedAttestation = null;
}

/** For tests / diagnostics. */
export function __internal(): { helper_path: string; ttl_sec: number; disabled: boolean; cached: boolean } {
  return {
    helper_path: ATTEST_HELPER_PATH,
    ttl_sec: ttlSec(),
    disabled: attestationDisabled(),
    cached: cachedAttestation !== null,
  };
}
