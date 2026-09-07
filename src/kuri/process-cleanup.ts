import { execFileSync } from "node:child_process";

export interface ProcessCleanupCommand {
  file: string;
  args: string[];
}

/**
 * Pure command planner for cleaning up an orphaned Chromium that owns one CDP
 * port. Keeping platform selection and quoting out of the broker lifecycle
 * makes the Windows path falsifiable on every CI host.
 */
export function chromiumCdpCleanupCommands(
  port: number,
  platform: NodeJS.Platform = process.platform,
): ProcessCleanupCommand[] {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];

  if (platform === "win32") {
    const marker = `--remote-debugging-port=${port}`;
    const script = `$marker = '${marker}'; ` + [
      "Get-CimInstance Win32_Process",
      "Where-Object { $_.Name -match '^(chrome|chromium|msedge)(\.exe)?$' -and $_.CommandLine -like \"*$marker*\" }",
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ].join(" | ");
    return [{
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    }];
  }

  return [{ file: "pkill", args: ["-f", `remote-debugging-port=${port}`] }];
}

export function cleanupChromiumOnCdpPort(
  port: number,
  platform: NodeJS.Platform = process.platform,
  execute: (file: string, args: string[]) => void = (file, args) => {
    execFileSync(file, args, { stdio: "ignore" });
  },
): boolean {
  const commands = chromiumCdpCleanupCommands(port, platform);
  if (commands.length === 0) return false;
  try {
    for (const command of commands) execute(command.file, command.args);
    return true;
  } catch {
    // Cleanup is best effort; the subsequent broker attempt remains the judge.
    return false;
  }
}
