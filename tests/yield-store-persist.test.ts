/**
 * yield-store-persist.test — disk persistence + sensitive-yield censoring.
 *
 * Uses the disk-backed moduleStore (default store) against a temp UNBROWSE_CONFIG_DIR,
 * so it exercises the real persist path without touching ~/.unbrowse. Cross-process
 * inheritance is proven by the gate (bench/.../gate_session_persist.sh); here we prove
 * the firmament: ids persist real, secrets persist as sha256 commitments only.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordYields, clearSessionYields } from "../src/runtime/yield-store.js";
import { commitValue } from "../src/proof/input-censor.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ub-yield-"));
  process.env.UNBROWSE_CONFIG_DIR = tmp;
});
afterAll(() => {
  delete process.env.UNBROWSE_CONFIG_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readSessionFiles(): string {
  const dir = path.join(tmp, "yield-sessions");
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf-8")).join("\n");
}

describe("yield-store disk persistence", () => {
  it("persists a non-sensitive id yield to disk in clear (real value)", () => {
    recordYields("ps-id", [{ key: "id", source: "response", example_value: "77" }]);
    expect(readSessionFiles()).toContain("77");
    clearSessionYields("ps-id");
  });

  it("FIRMAMENT: a sensitive yield is committed on disk, never in clear", () => {
    const secret = "S3KRIT-token-value";
    recordYields("ps-sec", [{ key: "password", source: "response", example_value: secret }]);
    const blob = readSessionFiles();
    expect(blob).not.toContain(secret); // cleartext never on disk
    expect(blob).toContain(commitValue(secret)); // the commitment is
    expect(blob).toContain('"committed":true');
    clearSessionYields("ps-sec");
  });

  it("clearSessionYields removes the disk file", () => {
    recordYields("ps-clear", [{ key: "id", source: "response", example_value: "9" }]);
    expect(readSessionFiles()).toContain("9");
    clearSessionYields("ps-clear");
    expect(readSessionFiles()).not.toContain("9");
  });
});
