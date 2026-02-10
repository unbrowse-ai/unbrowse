import { describe, it, expect } from "bun:test";

import { SkillIndexClient } from "../../src/skill-index.js";
import { generateBase58Keypair } from "../../src/solana/solana-helpers.js";
import { withBackend } from "./backend-harness.js";

describe("SkillIndexClient (e2e)", () => {
  it("publish/re-publish/download/versioning works against the real backend", { timeout: 180_000 }, async () => {
    await withBackend(async (backend) => {
      const { publicKey, privateKeyB58 } = await generateBase58Keypair();
      const client = new SkillIndexClient({
        indexUrl: backend.baseUrl,
        creatorWallet: publicKey,
        solanaPrivateKey: privateKeyB58,
      });

      const suffix = Math.random().toString(16).slice(2, 10);
      const name = `e2e-skill-${suffix}`; // must match backend regex: ^[a-z][a-z0-9-]*$
      const markerV1 = `e2e-marker:${suffix}:v1`;
      const markerV2 = `e2e-marker:${suffix}:v2`;

      const initialSkillMd = [
        "---",
        `name: ${name}`,
        "description: >-",
        "  End-to-end test skill used by unbrowse-openclaw to validate marketplace flows.",
        "---",
        `# ${name}`,
        "",
        "This skill exists only for automated integration testing against a real backend.",
        "It is intentionally verbose so it passes backend validation rules (min lengths).",
        "Safe to delete.",
        "",
        markerV1,
        "",
      ].join("\n");

      const pub = await client.publish({
        name,
        description:
          "End-to-end test skill used by unbrowse-openclaw to validate publish/re-publish/download flows.",
        skillMd: initialSkillMd,
        priceUsdc: "0",
      });
      expect(pub.success).toBe(true);
      expect(typeof pub.skill.skillId).toBe("string");
      expect(pub.skill.skillId.length).toBeGreaterThan(5);

      const id = pub.skill.skillId;

      const summary = await client.getSkillSummary(id);
      expect(summary.skillId).toBe(id);
      expect(summary.name).toBe(name);

      const dl = await client.download(id);
      expect(dl.skillId).toBe(id);
      expect(dl.name).toBe(name);
      expect(dl.skillMd.includes(markerV1)).toBe(true);

      const versionsV1 = await client.getVersions(id);
      expect(versionsV1.length).toBeGreaterThanOrEqual(1);
      const v1 = versionsV1.find((v) => v.isLatest) ?? versionsV1[0]!;
      expect(typeof v1.versionHash).toBe("string");
      expect(v1.versionHash.length).toBeGreaterThan(8);

      const dlV1 = await client.downloadVersion(id, v1.versionHash);
      expect(dlV1.skillMd.includes(markerV1)).toBe(true);

      // "Update" is done by re-publishing with the same (name, creatorWallet); the backend records a new version.
      const updatedSkillMd = `${initialSkillMd}\n## Update\n\nSecond publish from tests.\n\n${markerV2}\n`;
      const upd = await client.publish({
        name,
        description:
          "End-to-end test skill updated by unbrowse-openclaw to validate re-publish/versioning behavior.",
        skillMd: updatedSkillMd,
        priceUsdc: "0",
      });
      expect(upd.success).toBe(true);
      expect(upd.skill.skillId).toBe(id);

      const dl2 = await client.download(id);
      expect(dl2.skillMd.includes(markerV2)).toBe(true);

      const versionsV2 = await client.getVersions(id);
      expect(versionsV2.length).toBeGreaterThanOrEqual(2);
      const latest = versionsV2.find((v) => v.isLatest);
      expect(latest).toBeTruthy();
      expect(latest!.versionHash).not.toBe(v1.versionHash);

      const dlLatest = await client.downloadVersion(id, latest!.versionHash);
      expect(dlLatest.skillMd.includes(markerV2)).toBe(true);
    });
  });

  it("paid download (402) fails fast when no wallet is configured", { timeout: 180_000 }, async () => {
    await withBackend(async (backend) => {
      const { publicKey, privateKeyB58 } = await generateBase58Keypair();
      const authed = new SkillIndexClient({
        indexUrl: backend.baseUrl,
        creatorWallet: publicKey,
        solanaPrivateKey: privateKeyB58,
      });

      const suffix = Math.random().toString(16).slice(2, 10);
      const name = `e2e-paid-${suffix}`;

      const pub = await authed.publish({
        name,
        description:
          "End-to-end paid test skill used by unbrowse-openclaw to ensure unpaid clients fail fast on download.",
        skillMd: [
          "---",
          `name: ${name}`,
          "description: >-",
          "  End-to-end paid test skill. Used to validate x402/402 payment-required behavior.",
          "---",
          `# ${name}`,
          "",
          "This paid skill is published during automated tests and then deleted.",
          "It is intentionally verbose so it passes backend validation rules (min lengths).",
          "Safe to delete.",
          "",
        ].join("\n"),
        priceUsdc: "1.00",
      });

      const id = pub.skill.skillId;

      const unauthed = new SkillIndexClient({ indexUrl: backend.baseUrl });
      await expect(unauthed.download(id)).rejects.toThrow(/requires payment/i);
    });
  });
});
