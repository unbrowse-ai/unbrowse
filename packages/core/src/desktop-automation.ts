/**
 * Desktop Automation — macOS AppleScript integration.
 *
 * When browser/API won't work, control desktop apps directly.
 * Uses AppleScript for macOS and supports common app patterns.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface DesktopResult {
  success: boolean;
  output?: string;
  error?: string;
}

// ── Desktop Automation ───────────────────────────────────────────────────────

export class DesktopAutomation {
  private logger?: { info: (msg: string) => void; error: (msg: string) => void };

  constructor(logger?: { info: (msg: string) => void; error: (msg: string) => void }) {
    this.logger = logger;
  }

  /**
   * Execute AppleScript.
   */
  async runAppleScript(script: string): Promise<DesktopResult> {
    this.logger?.error("[desktop] AppleScript execution disabled in this build.");
    return {
      success: false,
      error: "Desktop automation is disabled in this build.",
      output: script.slice(0, 120),
    };
  }

  /**
   * Execute multi-line AppleScript.
   */
  async runAppleScriptLines(lines: string[]): Promise<DesktopResult> {
    return this.runAppleScript(lines.join("\n"));
  }

  // ── App Control ─────────────────────────────────────────────────────────────

  /**
   * Open/activate an application.
   */
  async openApp(appName: string): Promise<DesktopResult> {
    return this.runAppleScript(`tell application "${appName}" to activate`);
  }

  /**
   * Quit an application.
   */
  async quitApp(appName: string): Promise<DesktopResult> {
    return this.runAppleScript(`tell application "${appName}" to quit`);
  }

  /**
   * Check if an application is running.
   */
  async isAppRunning(appName: string): Promise<boolean> {
    const result = await this.runAppleScript(
      `tell application "System Events" to (name of processes) contains "${appName}"`
    );
    return result.output === "true";
  }

  /**
   * List running applications.
   */
  async listRunningApps(): Promise<string[]> {
    const result = await this.runAppleScript(
      `tell application "System Events" to get name of every process whose background only is false`
    );
    if (!result.success || !result.output) return [];
    // Output is comma-separated
    return result.output.split(", ").map((s) => s.trim());
  }

  // ── Input Control ───────────────────────────────────────────────────────────

  /**
   * Type text (keystroke).
   */
  async typeText(text: string): Promise<DesktopResult> {
    // Escape special characters
    const escaped = text.replace(/"/g, '\\"');
    return this.runAppleScript(
      `tell application "System Events" to keystroke "${escaped}"`
    );
  }

  /**
   * Press a key with optional modifiers.
   */
  async pressKey(
    key: string,
    modifiers: ("command" | "option" | "control" | "shift")[] = []
  ): Promise<DesktopResult> {
    const keyCode = this.getKeyCode(key);
    if (keyCode === null) {
      return { success: false, error: `Unknown key: ${key}` };
    }

    const modifierStr = modifiers.length
      ? ` using {${modifiers.map((m) => m + " down").join(", ")}}`
      : "";

    return this.runAppleScript(
      `tell application "System Events" to key code ${keyCode}${modifierStr}`
    );
  }

  /**
   * Get key code for common keys.
   */
  private getKeyCode(key: string): number | null {
    const keyCodes: Record<string, number> = {
      return: 36,
      enter: 76,
      tab: 48,
      space: 49,
      delete: 51,
      escape: 53,
      left: 123,
      right: 124,
      down: 125,
      up: 126,
      f1: 122,
      f2: 120,
      f3: 99,
      f4: 118,
      f5: 96,
      f6: 97,
      f7: 98,
      f8: 100,
      f9: 101,
      f10: 109,
      f11: 103,
      f12: 111,
    };
    return keyCodes[key.toLowerCase()] ?? null;
  }

  /**
   * Click at coordinates.
   */
  async click(x: number, y: number): Promise<DesktopResult> {
    return this.runAppleScriptLines([
      'tell application "System Events"',
      `  click at {${x}, ${y}}`,
      "end tell",
    ]);
  }

  // ── Clipboard ───────────────────────────────────────────────────────────────

  /**
   * Get clipboard contents.
   */
  async getClipboard(): Promise<string> {
    const result = await this.runAppleScript("get the clipboard");
    return result.output || "";
  }

  /**
   * Set clipboard contents.
   */
  async setClipboard(text: string): Promise<DesktopResult> {
    const escaped = text.replace(/"/g, '\\"');
    return this.runAppleScript(`set the clipboard to "${escaped}"`);
  }

  // ── Notifications ───────────────────────────────────────────────────────────

  /**
   * Show a notification.
   */
  async notify(title: string, message: string): Promise<DesktopResult> {
    return this.runAppleScript(
      `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`
    );
  }

  /**
   * Show an alert dialog.
   */
  async alert(title: string, message: string): Promise<DesktopResult> {
    return this.runAppleScript(
      `display alert "${title.replace(/"/g, '\\"')}" message "${message.replace(/"/g, '\\"')}"`
    );
  }

  // ── App-Specific Commands ───────────────────────────────────────────────────

  /**
   * Notes: Create a new note.
   */
  async notesCreate(body: string, folder?: string): Promise<DesktopResult> {
    const escaped = body.replace(/"/g, '\\"');
    const folderLine = folder
      ? `in folder "${folder.replace(/"/g, '\\"')}"`
      : "";

    return this.runAppleScriptLines([
      'tell application "Notes"',
      `  make new note ${folderLine} with properties {body:"${escaped}"}`,
      "end tell",
    ]);
  }

  /**
   * Reminders: Create a new reminder.
   */
  async remindersCreate(
    title: string,
    dueDate?: Date,
    list?: string
  ): Promise<DesktopResult> {
    const escaped = title.replace(/"/g, '\\"');
    const lines = ['tell application "Reminders"'];

    if (list) {
      lines.push(`  tell list "${list.replace(/"/g, '\\"')}"`);
    }

    if (dueDate) {
      const dateStr = `date "${dueDate.toLocaleDateString()} ${dueDate.toLocaleTimeString()}"`;
      lines.push(`    make new reminder with properties {name:"${escaped}", due date:${dateStr}}`);
    } else {
      lines.push(`    make new reminder with properties {name:"${escaped}"}`);
    }

    if (list) {
      lines.push("  end tell");
    }

    lines.push("end tell");
    return this.runAppleScriptLines(lines);
  }

  /**
   * Calendar: Create a new event.
   */
  async calendarCreateEvent(
    title: string,
    startDate: Date,
    endDate: Date,
    calendar?: string
  ): Promise<DesktopResult> {
    const escaped = title.replace(/"/g, '\\"');
    const calendarName = calendar || "Calendar";

    return this.runAppleScriptLines([
      'tell application "Calendar"',
      `  tell calendar "${calendarName.replace(/"/g, '\\"')}"`,
      `    make new event with properties {summary:"${escaped}", start date:date "${startDate.toLocaleString()}", end date:date "${endDate.toLocaleString()}"}`,
      "  end tell",
      "end tell",
    ]);
  }

  /**
   * Finder: Open a folder.
   */
  async finderOpen(path: string): Promise<DesktopResult> {
    const posixPath = path.replace(/"/g, '\\"');
    return this.runAppleScript(
      `tell application "Finder" to open POSIX file "${posixPath}"`
    );
  }

  /**
   * Finder: Get selected files.
   */
  async finderGetSelection(): Promise<string[]> {
    const result = await this.runAppleScriptLines([
      'tell application "Finder"',
      "  set selectedItems to selection as alias list",
      "  set output to {}",
      "  repeat with anItem in selectedItems",
      "    set end of output to POSIX path of anItem",
      "  end repeat",
      '  return output as string',
      "end tell",
    ]);

    if (!result.success || !result.output) return [];
    return result.output.split(", ").filter(Boolean);
  }

  /**
   * Safari: Get current URL.
   */
  async safariGetUrl(): Promise<string> {
    const result = await this.runAppleScript(
      'tell application "Safari" to get URL of current tab of front window'
    );
    return result.output || "";
  }

  /**
   * Safari: Open URL.
   */
  async safariOpen(url: string): Promise<DesktopResult> {
    return this.runAppleScript(
      `tell application "Safari" to open location "${url.replace(/"/g, '\\"')}"`
    );
  }

  /**
   * Chrome: Get current URL.
   */
  async chromeGetUrl(): Promise<string> {
    const result = await this.runAppleScript(
      'tell application "Google Chrome" to get URL of active tab of front window'
    );
    return result.output || "";
  }

  /**
   * Chrome: Open URL.
   */
  async chromeOpen(url: string): Promise<DesktopResult> {
    return this.runAppleScriptLines([
      'tell application "Google Chrome"',
      "  activate",
      `  open location "${url.replace(/"/g, '\\"')}"`,
      "end tell",
    ]);
  }

  /**
   * Terminal: Run command.
   */
  async terminalRun(command: string): Promise<DesktopResult> {
    const escaped = command.replace(/"/g, '\\"');
    return this.runAppleScriptLines([
      'tell application "Terminal"',
      "  activate",
      `  do script "${escaped}"`,
      "end tell",
    ]);
  }

  /**
   * Messages: Send iMessage.
   */
  async messagesImessage(to: string, message: string): Promise<DesktopResult> {
    const escapedTo = to.replace(/"/g, '\\"');
    const escapedMsg = message.replace(/"/g, '\\"');

    return this.runAppleScriptLines([
      'tell application "Messages"',
      `  set targetBuddy to "${escapedTo}"`,
      "  set targetService to 1st account whose service type = iMessage",
      `  send "${escapedMsg}" to participant targetBuddy of account targetService`,
      "end tell",
    ]);
  }

  // ── Generic App Actions ─────────────────────────────────────────────────────

  /**
   * Execute a menu item.
   */
  async clickMenuItem(
    appName: string,
    menuPath: string[]
  ): Promise<DesktopResult> {
    if (menuPath.length < 2) {
      return { success: false, error: "Menu path must have at least 2 items (menu, item)" };
    }

    const lines = [
      'tell application "System Events"',
      `  tell process "${appName.replace(/"/g, '\\"')}"`,
    ];

    // Build menu item path
    let current = `menu bar 1's menu bar item "${menuPath[0].replace(/"/g, '\\"')}"'s menu "${menuPath[0].replace(/"/g, '\\"')}"`;

    for (let i = 1; i < menuPath.length - 1; i++) {
      current += `'s menu item "${menuPath[i].replace(/"/g, '\\"')}"'s menu "${menuPath[i].replace(/"/g, '\\"')}"`;
    }

    const lastItem = menuPath[menuPath.length - 1].replace(/"/g, '\\"');
    lines.push(`    click menu item "${lastItem}" of ${current}`);
    lines.push("  end tell");
    lines.push("end tell");

    return this.runAppleScriptLines(lines);
  }

  /**
   * Get window list for an app.
   */
  async getWindows(appName: string): Promise<string[]> {
    const result = await this.runAppleScript(
      `tell application "${appName.replace(/"/g, '\\"')}" to get name of every window`
    );
    if (!result.success || !result.output) return [];
    return result.output.split(", ").map((s) => s.trim());
  }

  /**
   * Focus a specific window.
   */
  async focusWindow(appName: string, windowName: string): Promise<DesktopResult> {
    return this.runAppleScriptLines([
      `tell application "${appName.replace(/"/g, '\\"')}"`,
      "  activate",
      `  set index of window "${windowName.replace(/"/g, '\\"')}" to 1`,
      "end tell",
    ]);
  }
}

export const desktopAutomation = new DesktopAutomation();
