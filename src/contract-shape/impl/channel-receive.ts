import { randomBytes } from "node:crypto";

interface Input {
  channel: string;
  filter?: {
    from?: string;
    subject_contains?: string;
    body_contains?: string;
  };
  timeout_ms?: number;
}

interface Output {
  message: {
    from: string;
    to: string;
    subject: string;
    body_text: string;
    body_html?: string;
    received_at: string;
  } | null;
  source_pointer: string;
  error?: string;
}

export default async function run(input: unknown): Promise<Output> {
  const req = input as Input;
  if (!req || typeof req !== "object" || typeof req.channel !== "string" || req.channel.length === 0) {
    return {
      message: null,
      source_pointer: "",
      error: "missing required field: channel",
    };
  }

  const allowedChannels = ["gmail", "imap", "agentmail", "resend", "whatsapp", "telegram", "discord", "slack", "sms"];
  if (!allowedChannels.includes(req.channel)) {
    return {
      message: null,
      source_pointer: "",
      error: `unsupported communication channel: ${req.channel}`,
    };
  }

  // Day 3: Minimal runnable seed. Simulated multi-channel receiver (CCN Core).
  // Dynamically polls or watches communication channels (like Telegram, Resend) for replies.
  const sourcePointer = `src-${Date.now()}-${randomBytes(8).toString("hex")}`;
  
  // Under Day-5 constraints, we will add strict validation and filters.
  const hasFilterMatch = req.filter?.from || req.filter?.body_contains || req.filter?.subject_contains;

  return {
    message: hasFilterMatch ? {
      from: req.filter?.from || "@user-tele-handle",
      to: "aiko-bot-enclave",
      subject: req.filter?.subject_contains || "Telegram Chat Reply",
      body_text: `Acknowledged: I received your ping for ${req.filter?.body_contains || "funding"}.`,
      received_at: new Date().toISOString(),
    } : null,
    source_pointer: sourcePointer,
  };
}
