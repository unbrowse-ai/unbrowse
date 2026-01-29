/**
 * OTP Watcher — Monitor macOS notifications/messages for OTP codes
 *
 * Sources:
 *   1. iMessage/SMS via ~/Library/Messages/chat.db (SQLite)
 *   2. Clipboard changes (user copies OTP)
 *   3. macOS Notification Center database
 *   4. Mail.app recent emails (via AppleScript)
 *
 * When an OTP is detected, it's stored and can be retrieved by unbrowse_interact
 * to auto-fill 2FA fields.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync, spawn, execSync } from "node:child_process";

/** Detected OTP code with metadata */
export interface OTPCode {
  code: string;
  source: "sms" | "clipboard" | "notification" | "email";
  timestamp: Date;
  sender?: string;
  message?: string;
}

/** OTP patterns - 4-8 digit codes, sometimes with dashes */
const OTP_PATTERNS = [
  /\b(\d{6})\b/,                    // 6 digits (most common)
  /\b(\d{4})\b/,                    // 4 digits
  /\b(\d{8})\b/,                    // 8 digits
  /\b(\d{3}[-\s]?\d{3})\b/,         // 3-3 format
  /code[:\s]+(\d{4,8})/i,           // "code: 123456"
  /otp[:\s]+(\d{4,8})/i,            // "OTP: 123456"
  /verification[:\s]+(\d{4,8})/i,   // "verification: 123456"
  /pin[:\s]+(\d{4,8})/i,            // "PIN: 1234"
];

/** Keywords that indicate a message contains an OTP */
const OTP_KEYWORDS = [
  "verification", "verify", "code", "otp", "2fa", "two-factor",
  "authentication", "login", "sign in", "signin", "confirm",
  "security", "one-time", "passcode", "pin"
];

/**
 * Extract OTP code from text
 * @param text - The text to extract OTP from
 * @param requireKeyword - If true, requires OTP keywords; if false, accepts bare codes (for clipboard)
 */
export function extractOTP(text: string, requireKeyword: boolean = true): string | null {
  const lowerText = text.toLowerCase();
  const trimmed = text.trim();

  // For clipboard: accept bare 4-8 digit codes directly
  if (!requireKeyword) {
    // Check if it's just a code (possibly with spaces/dashes)
    const bareCode = trimmed.replace(/[-\s]/g, "");
    if (/^\d{4,8}$/.test(bareCode)) {
      return bareCode;
    }
  }

  // Check if message likely contains an OTP
  const hasKeyword = OTP_KEYWORDS.some(kw => lowerText.includes(kw));
  if (requireKeyword && !hasKeyword) return null;

  // Try each pattern
  for (const pattern of OTP_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Clean up the code (remove dashes/spaces)
      return match[1].replace(/[-\s]/g, "");
    }
  }

  return null;
}

/**
 * Read recent messages from iMessage/SMS database
 */
export async function readRecentMessages(
  sinceMinutes: number = 5
): Promise<Array<{ text: string; sender: string; date: Date }>> {
  const dbPath = join(homedir(), "Library/Messages/chat.db");

  if (!existsSync(dbPath)) {
    return [];
  }

  // Use sqlite3 CLI to query (avoids native module dependency)
  const sinceTimestamp = Date.now() / 1000 - sinceMinutes * 60;
  // iMessage uses Mac absolute time (seconds since 2001-01-01)
  const macTimestamp = sinceTimestamp - 978307200;

  const query = `
    SELECT
      message.text,
      handle.id as sender,
      message.date / 1000000000 + 978307200 as unix_date
    FROM message
    LEFT JOIN handle ON message.handle_id = handle.ROWID
    WHERE message.date / 1000000000 > ${macTimestamp}
    ORDER BY message.date DESC
    LIMIT 20;
  `;

  try {
    const result = spawnSync("sqlite3", ["-json", dbPath, query], {
      encoding: "utf-8",
      timeout: 5000,
    });

    if (result.status !== 0 || !result.stdout) {
      return [];
    }

    const rows = JSON.parse(result.stdout);
    return rows.map((row: any) => ({
      text: row.text ?? "",
      sender: row.sender ?? "unknown",
      date: new Date(row.unix_date * 1000),
    }));
  } catch {
    return [];
  }
}

/**
 * Get current clipboard content
 */
export function getClipboard(): string {
  try {
    const result = spawnSync("pbpaste", [], { encoding: "utf-8", timeout: 1000 });
    return result.stdout ?? "";
  } catch {
    return "";
  }
}

/**
 * Read recent notifications from macOS Notification Center database
 */
export async function readRecentNotifications(
  sinceMinutes: number = 5
): Promise<Array<{ text: string; app: string; date: Date }>> {
  // Notification Center DB location (may vary by macOS version)
  const dbPaths = [
    join(homedir(), "Library/Group Containers/group.com.apple.usernoted/db2/db"),
    join(homedir(), "Library/Application Support/NotificationCenter/db2/db"),
  ];

  let dbPath: string | null = null;
  for (const p of dbPaths) {
    if (existsSync(p)) {
      dbPath = p;
      break;
    }
  }

  if (!dbPath) return [];

  const sinceTimestamp = Date.now() / 1000 - sinceMinutes * 60;

  // Query for recent notifications
  const query = `
    SELECT
      data,
      delivered_date
    FROM record
    WHERE delivered_date > ${sinceTimestamp}
    ORDER BY delivered_date DESC
    LIMIT 50;
  `;

  try {
    const result = spawnSync("sqlite3", ["-json", dbPath, query], {
      encoding: "utf-8",
      timeout: 5000,
    });

    if (result.status !== 0 || !result.stdout) {
      return [];
    }

    const rows = JSON.parse(result.stdout);
    const notifications: Array<{ text: string; app: string; date: Date }> = [];

    for (const row of rows) {
      try {
        // Notification data is a binary plist, try to extract text
        // For now, we'll use a simpler approach - check if it's readable
        const data = row.data;
        if (typeof data === "string" && data.length > 0) {
          // Try to find OTP-like content in the raw data
          const match = data.match(/\b(\d{4,8})\b/);
          if (match) {
            notifications.push({
              text: data.slice(0, 500),
              app: "notification",
              date: new Date(row.delivered_date * 1000),
            });
          }
        }
      } catch { /* skip malformed */ }
    }

    return notifications;
  } catch {
    return [];
  }
}

/**
 * Read recent emails from Mail.app via AppleScript
 */
export async function readRecentEmails(
  sinceMinutes: number = 10
): Promise<Array<{ subject: string; body: string; sender: string; date: Date }>> {
  const script = `
    tell application "Mail"
      set recentMails to {}
      set cutoffDate to (current date) - (${sinceMinutes} * 60)

      repeat with theAccount in accounts
        repeat with theMailbox in mailboxes of theAccount
          try
            set theMessages to (messages of theMailbox whose date received > cutoffDate)
            repeat with theMessage in theMessages
              set msgSubject to subject of theMessage
              set msgBody to content of theMessage
              set msgSender to sender of theMessage
              set msgDate to date received of theMessage

              -- Only include if it looks like a verification email
              if msgSubject contains "code" or msgSubject contains "verify" or msgSubject contains "OTP" or msgSubject contains "login" or msgSubject contains "authentication" then
                set end of recentMails to {subject:msgSubject, body:(text 1 thru 500 of msgBody), sender:msgSender, dateStr:(msgDate as string)}
              end if
            end repeat
          end try
        end repeat
      end repeat

      return recentMails
    end tell
  `;

  try {
    const result = spawnSync("osascript", ["-e", script], {
      encoding: "utf-8",
      timeout: 10000,
    });

    if (result.status !== 0 || !result.stdout) {
      return [];
    }

    // Parse AppleScript output (it's a list of records)
    // Format: {{subject:"...", body:"...", sender:"...", dateStr:"..."}, ...}
    const output = result.stdout.trim();
    if (!output || output === "{}") return [];

    // Simple parsing - this is fragile but works for basic cases
    const emails: Array<{ subject: string; body: string; sender: string; date: Date }> = [];

    // AppleScript returns records in a specific format, parse them
    const recordMatch = output.match(/\{subject:"([^"]*)", body:"([^"]*)", sender:"([^"]*)", dateStr:"([^"]*)"\}/g);
    if (recordMatch) {
      for (const record of recordMatch) {
        const parts = record.match(/subject:"([^"]*)", body:"([^"]*)", sender:"([^"]*)", dateStr:"([^"]*)"/);
        if (parts) {
          emails.push({
            subject: parts[1],
            body: parts[2],
            sender: parts[3],
            date: new Date(parts[4]),
          });
        }
      }
    }

    return emails;
  } catch {
    return [];
  }
}

/**
 * Get recent notifications using `log stream` (monitors system log)
 * This is a fallback method that watches for notification events
 */
export function startNotificationLogStream(
  callback: (notification: { app: string; title: string; body: string }) => void
): { stop: () => void } {
  // Use `log stream` to monitor notification events
  const logProcess = spawn("log", [
    "stream",
    "--predicate", 'subsystem == "com.apple.UNUserNotificationCenter"',
    "--style", "json",
  ], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  let buffer = "";

  logProcess.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();

    // Try to parse complete JSON lines
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const message = event.eventMessage ?? "";

        // Look for notification content
        if (message.includes("UNNotification") || message.includes("delivered")) {
          callback({
            app: event.processImagePath ?? "unknown",
            title: "",
            body: message,
          });
        }
      } catch { /* ignore parse errors */ }
    }
  });

  return {
    stop: () => {
      logProcess.kill();
    },
  };
}

/**
 * OTP Watcher class - monitors for OTP codes
 */
export class OTPWatcher {
  private lastClipboard: string = "";
  private lastMessageDate: Date = new Date();
  private pendingOTPs: OTPCode[] = [];
  private pollInterval: NodeJS.Timeout | null = null;
  private onOTP: ((otp: OTPCode) => void) | null = null;

  constructor() {
    this.lastClipboard = getClipboard();
    this.lastMessageDate = new Date();
  }

  /**
   * Start watching for OTPs
   */
  start(callback?: (otp: OTPCode) => void): void {
    if (this.pollInterval) return;

    this.onOTP = callback ?? null;

    // Poll every 2 seconds
    this.pollInterval = setInterval(() => this.poll(), 2000);

    // Initial poll
    this.poll();
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Poll for new OTPs
   */
  private async poll(): Promise<void> {
    // Check clipboard (don't require keywords - bare codes are likely OTPs)
    const clipboard = getClipboard();
    if (clipboard !== this.lastClipboard) {
      this.lastClipboard = clipboard;
      const code = extractOTP(clipboard, false); // false = accept bare codes
      if (code) {
        this.addOTP({
          code,
          source: "clipboard",
          timestamp: new Date(),
          message: clipboard.slice(0, 100),
        });
      }
    }

    // Check iMessage/SMS
    try {
      const messages = await readRecentMessages(2); // Last 2 minutes
      for (const msg of messages) {
        if (msg.date > this.lastMessageDate && msg.text) {
          const code = extractOTP(msg.text);
          if (code) {
            this.addOTP({
              code,
              source: "sms",
              timestamp: msg.date,
              sender: msg.sender,
              message: msg.text.slice(0, 100),
            });
          }
        }
      }
      if (messages.length > 0) {
        this.lastMessageDate = messages[0].date;
      }
    } catch {
      // Messages not accessible
    }

    // Check macOS Notification Center (every 3rd poll to reduce load)
    if (Math.random() < 0.33) {
      try {
        const notifications = await readRecentNotifications(2);
        for (const notif of notifications) {
          const code = extractOTP(notif.text);
          if (code) {
            this.addOTP({
              code,
              source: "notification",
              timestamp: notif.date,
              sender: notif.app,
              message: notif.text.slice(0, 100),
            });
          }
        }
      } catch {
        // Notifications not accessible
      }
    }

    // Check Mail.app (every 5th poll - emails are slower)
    if (Math.random() < 0.2) {
      try {
        const emails = await readRecentEmails(5);
        for (const email of emails) {
          // Check both subject and body for OTP
          const code = extractOTP(email.subject + " " + email.body);
          if (code) {
            this.addOTP({
              code,
              source: "email",
              timestamp: email.date,
              sender: email.sender,
              message: `${email.subject}: ${email.body.slice(0, 50)}`,
            });
          }
        }
      } catch {
        // Mail not accessible
      }
    }
  }

  /**
   * Add an OTP to the queue
   */
  private addOTP(otp: OTPCode): void {
    // Dedupe - don't add same code twice within 30s
    const isDupe = this.pendingOTPs.some(
      p => p.code === otp.code &&
           Date.now() - p.timestamp.getTime() < 30000
    );
    if (isDupe) return;

    this.pendingOTPs.push(otp);

    // Keep only last 10
    if (this.pendingOTPs.length > 10) {
      this.pendingOTPs.shift();
    }

    // Notify callback
    if (this.onOTP) {
      this.onOTP(otp);
    }
  }

  /**
   * Get the most recent OTP (within last 5 minutes)
   */
  getLatestOTP(): OTPCode | null {
    const cutoff = Date.now() - 5 * 60 * 1000;
    const recent = this.pendingOTPs.filter(o => o.timestamp.getTime() > cutoff);
    return recent.length > 0 ? recent[recent.length - 1] : null;
  }

  /**
   * Wait for an OTP to arrive (with timeout)
   */
  async waitForOTP(timeoutMs: number = 60000): Promise<OTPCode | null> {
    const startTime = Date.now();

    // Check if we already have a recent OTP
    const existing = this.getLatestOTP();
    if (existing && Date.now() - existing.timestamp.getTime() < 10000) {
      return existing;
    }

    // Wait for new OTP
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const otp = this.getLatestOTP();
        if (otp && otp.timestamp.getTime() > startTime) {
          clearInterval(checkInterval);
          resolve(otp);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          resolve(null);
        }
      }, 1000);
    });
  }

  /**
   * Clear pending OTPs
   */
  clear(): void {
    this.pendingOTPs = [];
  }
}

// Singleton instance
let globalWatcher: OTPWatcher | null = null;

/**
 * Get or create the global OTP watcher
 */
export function getOTPWatcher(): OTPWatcher {
  if (!globalWatcher) {
    globalWatcher = new OTPWatcher();
  }
  return globalWatcher;
}

/**
 * Start the global OTP watcher
 */
export function startOTPWatcher(
  callback?: (otp: OTPCode) => void
): OTPWatcher {
  const watcher = getOTPWatcher();
  watcher.start(callback);
  return watcher;
}

/**
 * Stop the global OTP watcher
 */
export function stopOTPWatcher(): void {
  if (globalWatcher) {
    globalWatcher.stop();
  }
}
