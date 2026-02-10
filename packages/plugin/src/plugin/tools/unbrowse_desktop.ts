import type { ToolDeps } from "./deps.js";
import { DesktopAutomation } from "./shared.js";

export function makeUnbrowseDesktopTool(deps: ToolDeps) {
  const { logger, enableDesktopAutomation } = deps;
  const desktopAuto = new DesktopAutomation(logger);

  return {
name: "unbrowse_desktop",
label: "Desktop Automation",
description:
"Control macOS desktop apps via AppleScript. Use when browser/API won't work, or for native apps " +
"like Notes, Reminders, Calendar, Finder, Messages, etc.",
parameters: {
type: "object" as const,
properties: {
  action: {
    type: "string" as const,
    enum: [
      "open_app", "quit_app", "list_apps",
      "type", "press_key", "click",
      "clipboard_get", "clipboard_set",
      "notify", "alert",
      "notes_create", "reminders_create", "calendar_event",
      "finder_open", "finder_selection",
      "safari_url", "safari_open", "chrome_url", "chrome_open",
      "terminal_run", "imessage_send",
      "menu_click", "window_list", "window_focus",
      "applescript",
    ],
    description: "The action to perform",
  },
  app: {
    type: "string" as const,
    description: "App name (for open_app, quit_app, menu_click, window actions)",
  },
  text: {
    type: "string" as const,
    description: "Text for type, clipboard_set, notes_create, notify, alert, imessage_send, applescript",
  },
  key: {
    type: "string" as const,
    description: "Key name for press_key (return, tab, escape, f1, etc.)",
  },
  modifiers: {
    type: "array" as const,
    items: { type: "string" as const },
    description: "Modifier keys for press_key (command, option, control, shift)",
  },
  x: { type: "number" as const, description: "X coordinate for click" },
  y: { type: "number" as const, description: "Y coordinate for click" },
  path: { type: "string" as const, description: "File/folder path for finder_open" },
  url: { type: "string" as const, description: "URL for safari_open, chrome_open" },
  command: { type: "string" as const, description: "Command for terminal_run" },
  to: { type: "string" as const, description: "Recipient for imessage_send" },
  title: { type: "string" as const, description: "Title for notify, alert, reminders_create, calendar_event" },
  message: { type: "string" as const, description: "Message for notify, alert" },
  menuPath: {
    type: "array" as const,
    items: { type: "string" as const },
    description: "Menu path for menu_click (e.g., ['File', 'New'])",
  },
  window: { type: "string" as const, description: "Window name for window_focus" },
  folder: { type: "string" as const, description: "Folder for notes_create" },
  list: { type: "string" as const, description: "List for reminders_create" },
  dueDate: { type: "string" as const, description: "ISO date for reminders_create" },
  startDate: { type: "string" as const, description: "ISO date for calendar_event" },
  endDate: { type: "string" as const, description: "ISO date for calendar_event" },
  calendar: { type: "string" as const, description: "Calendar name for calendar_event" },
},
required: ["action"],
},
async execute(_toolCallId: string, params: unknown) {
// Desktop automation is opt-in only
if (!enableDesktopAutomation) {
  return {
    content: [{
      type: "text",
      text: `Desktop automation is disabled by default for security.\n\nTo enable, add to your config:\n\n  "plugins": {\n    "entries": {\n      "unbrowse": {\n        "config": {\n          "enableDesktopAutomation": true\n        }\n      }\n    }\n  }\n\nSee SECURITY.md for details on what this enables.`,
    }],
  };
}

const p = params as any;
const { action, ...rest } = p;

try {
  let result;

  switch (action) {
    case "open_app":
      result = await desktopAuto.openApp(rest.app);
      break;
    case "quit_app":
      result = await desktopAuto.quitApp(rest.app);
      break;
    case "list_apps":
      const apps = await desktopAuto.listRunningApps();
      return { content: [{ type: "text", text: `Running apps:\n${apps.join("\n")}` }] };

    case "type":
      result = await desktopAuto.typeText(rest.text);
      break;
    case "press_key":
      result = await desktopAuto.pressKey(rest.key, rest.modifiers || []);
      break;
    case "click":
      result = await desktopAuto.click(rest.x, rest.y);
      break;

    case "clipboard_get":
      const clip = await desktopAuto.getClipboard();
      return { content: [{ type: "text", text: `Clipboard: ${clip}` }] };
    case "clipboard_set":
      result = await desktopAuto.setClipboard(rest.text);
      break;

    case "notify":
      result = await desktopAuto.notify(rest.title, rest.message || rest.text);
      break;
    case "alert":
      result = await desktopAuto.alert(rest.title, rest.message || rest.text);
      break;

    case "notes_create":
      result = await desktopAuto.notesCreate(rest.text, rest.folder);
      break;
    case "reminders_create":
      const dueDate = rest.dueDate ? new Date(rest.dueDate) : undefined;
      result = await desktopAuto.remindersCreate(rest.title || rest.text, dueDate, rest.list);
      break;
    case "calendar_event":
      const start = new Date(rest.startDate);
      const end = rest.endDate ? new Date(rest.endDate) : new Date(start.getTime() + 3600000);
      result = await desktopAuto.calendarCreateEvent(rest.title, start, end, rest.calendar);
      break;

    case "finder_open":
      result = await desktopAuto.finderOpen(rest.path);
      break;
    case "finder_selection":
      const selection = await desktopAuto.finderGetSelection();
      return { content: [{ type: "text", text: `Selected files:\n${selection.join("\n") || "(none)"}` }] };

    case "safari_url":
      const safariUrl = await desktopAuto.safariGetUrl();
      return { content: [{ type: "text", text: `Safari URL: ${safariUrl}` }] };
    case "safari_open":
      result = await desktopAuto.safariOpen(rest.url);
      break;
    case "chrome_url":
      const chromeUrl = await desktopAuto.chromeGetUrl();
      return { content: [{ type: "text", text: `Chrome URL: ${chromeUrl}` }] };
    case "chrome_open":
      result = await desktopAuto.chromeOpen(rest.url);
      break;

    case "terminal_run":
      result = await desktopAuto.terminalRun(rest.command);
      break;
    case "imessage_send":
      result = await desktopAuto.messagesImessage(rest.to, rest.text || rest.message);
      break;

    case "menu_click":
      result = await desktopAuto.clickMenuItem(rest.app, rest.menuPath);
      break;
    case "window_list":
      const windows = await desktopAuto.getWindows(rest.app);
      return { content: [{ type: "text", text: `Windows:\n${windows.join("\n") || "(none)"}` }] };
    case "window_focus":
      result = await desktopAuto.focusWindow(rest.app, rest.window);
      break;

    case "applescript":
      result = await desktopAuto.runAppleScript(rest.text);
      break;

    default:
      return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
  }

  if (result.success) {
    return { content: [{ type: "text", text: result.output || "Success" }] };
  } else {
    return { content: [{ type: "text", text: `Failed: ${result.error}` }] };
  }
} catch (err) {
  return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
}
},
};
}
