import { describe, expect, it } from "bun:test";
import runChannelSend from "../src/contract-shape/impl/channel-send.js";
import runChannelReceive from "../src/contract-shape/impl/channel-receive.js";
import { byName } from "../src/contract-shape/registry.js";

describe("Channel Communication Neurons (Luminaries)", () => {
  it("channel-send and channel-receive are registered and can be looked up", () => {
    const sendSpec = byName("channel-send");
    expect(sendSpec).toBeDefined();
    expect(sendSpec?.contract_id).toBe("edc1c467");

    const receiveSpec = byName("channel-receive");
    expect(receiveSpec).toBeDefined();
    expect(receiveSpec?.contract_id).toBe("edc1c467");
  });

  describe("channel-send implementation (Day 5 - Golden + Edges + Adversarial)", () => {
    it("fails cleanly on missing required fields (edge)", async () => {
      const res = await runChannelSend({});
      expect(res.message_id).toBe("");
      expect(res.error).toContain("missing required fields");
    });

    it("successfully sends message (golden)", async () => {
      const res = await runChannelSend({
        channel: "telegram",
        envelope: {
          to: "@user-telegram-chat",
          body_text: "Aiko: contract deployed successfully!",
        },
      });
      expect(res.channel).toBe("telegram");
      expect(res.message_id).toContain("msg-");
      expect(res.recipient_hash.length).toBe(64); // SHA256 of recipient
    });

    it("fails on unsupported channel (edge)", async () => {
      const res = await runChannelSend({
        channel: "invalid-channel-chat" as any,
        envelope: {
          to: "@recipient",
          body_text: "alert",
        },
      });
      expect(res.message_id).toBe("");
      expect(res.error).toContain("unsupported");
    });

    it("fails on invalid Telegram handle format (edge)", async () => {
      const res = await runChannelSend({
        channel: "telegram",
        envelope: {
          to: "invalid_handle_without_at",
          body_text: "alert",
        },
      });
      expect(res.message_id).toBe("");
      expect(res.error).toContain("invalid Telegram recipient format");
    });

    it("fails on empty message body (adversarial)", async () => {
      const res = await runChannelSend({
        channel: "telegram",
        envelope: {
          to: "@recipient",
          body_text: "   ",
        },
      });
      expect(res.message_id).toBe("");
      expect(res.error).toContain("cannot be empty");
    });

    it("fails on message body exceeding 4KB limit (adversarial)", async () => {
      const longBody = "a".repeat(4097);
      const res = await runChannelSend({
        channel: "telegram",
        envelope: {
          to: "@recipient",
          body_text: longBody,
        },
      });
      expect(res.message_id).toBe("");
      expect(res.error).toContain("exceeds maximum size limit");
    });
  });

  describe("channel-receive implementation (Day 5 - Golden + Edges + Adversarial)", () => {
    it("fails cleanly on missing channel (edge)", async () => {
      const res = await runChannelReceive({});
      expect(res.message).toBeNull();
      expect(res.error).toContain("missing required field");
    });

    it("fails on unsupported channel type (edge)", async () => {
      const res = await runChannelReceive({ channel: "invalid-chat" });
      expect(res.message).toBeNull();
      expect(res.error).toContain("unsupported");
    });

    it("returns null when no filter is provided (golden)", async () => {
      const res = await runChannelReceive({ channel: "telegram" });
      expect(res.message).toBeNull();
      expect(typeof res.source_pointer).toBe("string");
    });

    it("successfully receives matching message (golden)", async () => {
      const res = await runChannelReceive({
        channel: "telegram",
        filter: {
          from: "@user-telegram-chat",
          body_contains: "funding",
        },
      });
      expect(res.message).not.toBeNull();
      expect(res.message?.from).toBe("@user-telegram-chat");
      expect(res.message?.body_text).toContain("funding");
    });
  });
});
