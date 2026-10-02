// Chromium cookie decryption on Linux: the key is the candidate that decrypts the profile's own cookies (GNOME
// keyring, KWallet or Chromium's fixed fallback), and a value no key decrypts is dropped, never sent as garbage.
// A Steam Deck's Chromium keeps its key in KWallet while a stale GNOME-keyring entry decrypts nothing: every synced
// cookie came out as binary, and the server then refused to send any request to those sites.
import { expect, test } from "bun:test";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { chromiumDecryptor } from "../src/cookies.ts";

/** What Chromium stores: "v10"/"v11", then AES-128-CBC (IV of spaces) of SHA-256(host) + the value, PKCS#7-padded. */
function encrypt(version: string, password: string, host: string, value: string): Uint8Array {
  const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const body = Buffer.concat([c.update(Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)])), c.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from(version), body]));
}

test.skipIf(process.platform !== "linux")("linux: the key that decrypts the profile's cookies is used, and a value no key decrypts is dropped", () => {
  const rows = [
    { host_key: ".reddit.com", encrypted_value: encrypt("v10", "peanuts", ".reddit.com", "loid-123") },
    { host_key: ".reddit.com", encrypted_value: encrypt("v11", "", ".reddit.com", "token-abc") },
    { host_key: "www.reddit.com", encrypted_value: encrypt("v11", "", "www.reddit.com", "csrf-xyz") },
    // Encrypted with a key this machine does not have: CBC still "decrypts" it, to garbage.
    { host_key: ".reddit.com", encrypted_value: encrypt("v11", "a-password-we-do-not-have", ".reddit.com", "secret") },
  ];
  const decrypt = chromiumDecryptor("Chromium", rows);
  expect(decrypt(rows[0]!.encrypted_value, rows[0]!.host_key)).toBe("loid-123");
  expect(decrypt(rows[1]!.encrypted_value, rows[1]!.host_key)).toBe("token-abc");
  expect(decrypt(rows[2]!.encrypted_value, rows[2]!.host_key)).toBe("csrf-xyz");
  expect(decrypt(rows[3]!.encrypted_value, rows[3]!.host_key)).toBe("");
});
