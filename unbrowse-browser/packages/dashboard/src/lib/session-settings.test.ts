import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SETTINGS,
  type SettingsBook,
  confirmSetting,
  settingsFor,
  settingsKey,
  whyFailed,
  withSetting,
} from "./session-settings";

const took = { success: true, exit_code: 0, stdout: '{"success":true}', stderr: "" };
const refused = {
  success: false,
  exit_code: 1,
  stdout: '{"success":false,"data":null,"error":"Browser not launched"}',
  stderr: "",
};

/** The way the panels use it: a book, a key, and the setting asked for. */
async function ask(book: SettingsBook, key: string, res: typeof took) {
  let next = book;
  let seenDuringCommand: SettingsBook | null = null;
  const why = await confirmSetting(
    async () => {
      seenDuringCommand = next;
      return res;
    },
    () => {
      next = withSetting(next, key, { offline: true });
    },
  );
  return { next, why, seenDuringCommand };
}

describe("a setting the dashboard asks for", () => {
  test("a refused command changes nothing, and says why", async () => {
    const { next, why } = await ask({}, "a:1", refused);
    expect(settingsFor(next, "a:1").offline).toBe(false);
    expect(why).toBe("Browser not launched");
  });

  test("a command that took is recorded", async () => {
    const { next, why } = await ask({}, "a:1", took);
    expect(settingsFor(next, "a:1").offline).toBe(true);
    expect(why).toBe("");
  });

  test("nothing is claimed while the command runs", async () => {
    const { seenDuringCommand } = await ask({}, "a:1", took);
    expect(seenDuringCommand!).toEqual({});
  });
});

describe("a setting across sessions", () => {
  test("leaving a session and coming back shows what its browser still has", () => {
    let book: SettingsBook = {};
    const a = settingsKey("a", 1);
    book = withSetting(book, a, { colorScheme: "dark", offline: true, harRecording: true });
    expect(settingsFor(book, settingsKey("b", 2))).toEqual(DEFAULT_SETTINGS);
    expect(settingsFor(book, a)).toEqual({
      device: null,
      colorScheme: "dark",
      offline: true,
      harRecording: true,
    });
  });

  test("an answer for a session left behind lands on that session", () => {
    const a = settingsKey("a", 1);
    const b = settingsKey("b", 2);
    const book = withSetting({}, a, { device: "iPhone 15" });
    expect(settingsFor(book, b).device).toBeNull();
  });

  test("a new session under an old name starts from the defaults", () => {
    const book = withSetting({}, settingsKey("a", 1), { offline: true });
    expect(settingsFor(book, settingsKey("a", 7)).offline).toBe(false);
  });
});

describe("why a command failed", () => {
  test("stderr first, then the response's error, then something plain", () => {
    expect(whyFailed({ ...refused, stderr: "no daemon" })).toBe("no daemon");
    expect(whyFailed(refused)).toBe("Browser not launched");
    expect(whyFailed({ ...refused, stdout: "" })).toBe("The command failed");
  });
});
