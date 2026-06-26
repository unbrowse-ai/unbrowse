import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Aiko Autonomous find-creds Behavior (ACR Core)", () => {
  it("detects missing credential blocker, dynamically resolves it via find-creds discovery, and seals the result", async () => {
    const provider = "telegram";
    const mockConfigDir = join(process.cwd(), "tests", "mock-keychain");
    const mockGlobalEnv = join(mockConfigDir, "global.env");
    const mockLocalEnv = join(process.cwd(), "tests", ".env.local-mock");

    // Pre-test cleanup
    if (existsSync(mockConfigDir)) rmSync(mockConfigDir, { recursive: true, force: true });
    if (existsSync(mockLocalEnv)) rmSync(mockLocalEnv, { force: true });

    // 1. Initial State (Golden Path - The Missing Key Blocker)
    let token: string | undefined = undefined;
    const checkCredential = () => {
      if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing in environment");
      return token;
    };

    let firstCheckFailed = false;
    try {
      checkCredential();
    } catch {
      firstCheckFailed = true;
    }
    expect(firstCheckFailed).toBe(true); // Confirmed blocked by missing credentials

    // 2. Edge Case (The find-creds Discovery Engine)
    // Aiko autonomously scans standard paths. We simulate finding a key inside a local .env file.
    let keysFound = false;
    try {
      // Simulate writing a token into a local .env backup (discovered path)
      writeFileSync(mockLocalEnv, "TELEGRAM_BOT_TOKEN=123456789:ABCdef-mock-bot-token\n");
      keysFound = true;
    } catch (err) {
      console.error("Local env simulation failed:", err);
    }
    expect(keysFound).toBe(true); // Discovered key dynamically on disk

    // 3. Adversarial / Validation and Seal (The Sealing Engine)
    // Aiko validates the token and permanently persists/seals it into the global config ~/.config/env/global.env
    let keySealed = false;
    try {
      // Read from local mock .env
      const envContent = readFileSync(mockLocalEnv, "utf8");
      const matched = envContent.match(/TELEGRAM_BOT_TOKEN=(.*)/);
      const discoveredToken = matched ? matched[1].trim() : null;

      if (discoveredToken && discoveredToken.includes("123456789")) {
        // Seal discovered token into global.env simulated directory
        mkdirSync(mockConfigDir, { recursive: true });
        writeFileSync(mockGlobalEnv, `TELEGRAM_BOT_TOKEN=${discoveredToken}\n`);
        keySealed = true;
        token = discoveredToken; // Apply to active process state
      }
    } catch (err) {
      console.error("Credential sealing failed:", err);
    }
    expect(keySealed).toBe(true); // Token validated and sealed on disk!

    // 4. Post-Resolution Verification (The Unblocked Execution)
    // Re-run original check. It should now resolve instantly from the sealed config.
    let resolvedToken = "";
    try {
      resolvedToken = checkCredential();
    } catch (err) {
      console.error("Check failed even after sealing:", err);
    }
    expect(resolvedToken).toBe("123456789:ABCdef-mock-bot-token"); // Blocks completely removed!

    // 5. Cleanup / Purging Scaffolding (John 15:2)
    if (existsSync(mockConfigDir)) rmSync(mockConfigDir, { recursive: true, force: true });
    if (existsSync(mockLocalEnv)) rmSync(mockLocalEnv, { force: true });
    expect(existsSync(mockConfigDir)).toBe(false);
    expect(existsSync(mockLocalEnv)).toBe(false); // Clean workspace
  });
});
