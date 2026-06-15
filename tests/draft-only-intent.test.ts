import { describe, expect, it } from "bun:test";

import {
  draftOnlyReadIntent,
  draftOnlySubjectHint,
  isDraftOnlyMutationIntent,
} from "../src/cli.js";

describe("draft-only marketplace/contact intents", () => {
  it("detects explicit draft-only contact requests", () => {
    expect(isDraftOnlyMutationIntent(
      "Draft a polite message asking whether the first iPhone listing is still available. Do not send the message, do not make an offer, and do not buy.",
    )).toBe(true);
    expect(isDraftOnlyMutationIntent(
      "Prepare an inquiry for the property agent without sending it.",
    )).toBe(true);
    expect(isDraftOnlyMutationIntent(
      "Draft a polite message asking whether the first iPhone 15 Pro listing is still available.",
    )).toBe(true);
  });

  it("does not classify actual send/buy requests as draft-only", () => {
    expect(isDraftOnlyMutationIntent("Message the seller and buy the first listing.")).toBe(false);
    expect(isDraftOnlyMutationIntent("Draft a message and send it to the seller.")).toBe(false);
    expect(isDraftOnlyMutationIntent("Find the first iPhone listing with price.")).toBe(false);
  });

  it("rewrites the lookup as read-only context gathering", () => {
    const rewritten = draftOnlyReadIntent(
      "Draft a polite message asking whether the first iPhone 15 Pro listing is still available. Do not send the message, do not make an offer, and do not buy.",
    );
    expect(rewritten).toContain("Find the first visible");
    expect(rewritten).toContain("iPhone 15 Pro listing");
    expect(rewritten).toContain("read-only context");
    expect(rewritten).not.toMatch(/\b(send|offer|buy|contact)\b/i);
    expect(rewritten).not.toContain("Draft a polite message");
  });

  it("preserves the public subject while stripping side-effect instructions", () => {
    expect(draftOnlySubjectHint(
      "Draft a polite message asking whether the first iPhone 15 Pro listing is still available. Do not send the message, do not make an offer, and do not buy.",
    )).toBe("first iPhone 15 Pro listing");
  });
});
