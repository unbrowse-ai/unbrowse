import { randomBytes, createHash } from "node:crypto";

interface Input {
  channel: "gmail" | "imap" | "agentmail" | "resend" | "whatsapp" | "telegram" | "discord" | "slack" | "sms";
  envelope: {
    to: string;
    subject?: string;
    body_text: string;
    body_html?: string;
    attachments?: unknown[];
  };
  identity_pointer?: string;
}

interface Output {
  message_id: string;
  sent_at_iso: string;
  channel: string;
  recipient_hash: string;
  error?: string;
}

export default async function run(input: unknown): Promise<Output> {
  const req = input as Input;
  if (!req || typeof req !== "object" || !req.channel || !req.envelope || typeof req.envelope.to !== "string" || typeof req.envelope.body_text !== "string") {
    return {
      message_id: "",
      sent_at_iso: new Date().toISOString(),
      channel: "",
      recipient_hash: "",
      error: "missing required fields: channel, envelope.to, envelope.body_text",
    };
  }

  const allowedChannels = ["gmail", "imap", "agentmail", "resend", "whatsapp", "telegram", "discord", "slack", "sms"];
  if (!allowedChannels.includes(req.channel)) {
    return {
      message_id: "",
      sent_at_iso: new Date().toISOString(),
      channel: "",
      recipient_hash: "",
      error: `unsupported communication channel: ${req.channel}`,
    };
  }

  // Telegram-specific edge check: handle name format validation
  if (req.channel === "telegram" && !req.envelope.to.startsWith("@") && !/^\d+$/.test(req.envelope.to)) {
    return {
      message_id: "",
      sent_at_iso: new Date().toISOString(),
      channel: "",
      recipient_hash: "",
      error: "invalid Telegram recipient format: must start with @ or represent a numeric chat id",
    };
  }

  // Adversarial check: block empty bodies and excessively large payloads (> 4KB)
  const cleanBody = req.envelope.body_text.trim();
  if (cleanBody.length === 0) {
    return {
      message_id: "",
      sent_at_iso: new Date().toISOString(),
      channel: "",
      recipient_hash: "",
      error: "message body_text cannot be empty",
    };
  }

  if (cleanBody.length > 4096) {
    return {
      message_id: "",
      sent_at_iso: new Date().toISOString(),
      channel: "",
      recipient_hash: "",
      error: "message body_text exceeds maximum size limit of 4096 characters",
    };
  }

  // Day 3: Minimal runnable seed. Simulated multi-channel sender (CCN Core).
  // Dynamically routes notifications to standard chat channels (like Telegram, Slack, Slack, Resend).
  const messageId = `msg-${Date.now()}-${randomBytes(8).toString("hex")}`;
  const sha256 = createHash("sha256");
  sha256.update(req.envelope.to);
  const recipientHash = sha256.digest("hex");

  // Under Day-5 constraints, we will add strict validation bounds for channels.
  return {
    message_id: messageId,
    sent_at_iso: new Date().toISOString(),
    channel: req.channel,
    recipient_hash: recipientHash,
  };
}
