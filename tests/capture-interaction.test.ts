import { describe, expect, it } from "bun:test";
import {
  deriveInteractionClickTerms,
  deriveInteractionQueryTerms,
  shouldAttemptInteractiveExploration,
} from "../src/capture/interaction.js";

describe("capture interaction heuristics", () => {
  it("derives search terms from URL params", () => {
    expect(
      deriveInteractionQueryTerms(
        "https://lu.ma/discover?q=AI+Singapore&city=Singapore",
        "search events",
      ),
    ).toEqual(["AI Singapore", "Singapore"]);
  });

  it("falls back to intent-derived query text when the URL has no search params", () => {
    expect(
      deriveInteractionQueryTerms(
        "https://lu.ma/discover",
        'search for "AI Singapore" events',
      ),
    ).toEqual(["AI Singapore"]);
  });

  it("derives click terms for RSVP flows", () => {
    const terms = deriveInteractionClickTerms(
      "https://lu.ma/sgaifoundersdinner",
      "register RSVP for this event",
    );
    expect(terms).toContain("register");
    expect(terms).toContain("rsvp");
    expect(terms).toContain("join");
  });

  it("attempts interactive exploration for discover URLs and action intents", () => {
    expect(
      shouldAttemptInteractiveExploration(
        "https://lu.ma/discover?q=AI+Singapore",
        "search events",
      ),
    ).toBe(true);
    expect(
      shouldAttemptInteractiveExploration(
        "https://lu.ma/sgaifoundersdinner",
        "register RSVP for this event",
      ),
    ).toBe(true);
    expect(
      shouldAttemptInteractiveExploration(
        "https://lu.ma",
        "get homepage title",
      ),
    ).toBe(false);
  });
});
