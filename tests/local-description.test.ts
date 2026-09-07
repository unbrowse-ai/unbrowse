import { describe, expect, test } from "bun:test";
import { generateLocalDescription } from "../src/orchestrator/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";

function endpoint(overrides: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "mandai-bundle",
    method: "GET",
    url_template:
      "https://www.mandai.com/en/ticketing/admission-and-rides/multi-park/2-parkhopper/2-parks-destination-pass-night-safari-and-river-wonders",
    idempotency: "safe",
    verification_status: "unverified",
    reliability_score: 0.8,
    ...overrides,
  };
}

describe("generateLocalDescription", () => {
  test("includes eligibility and validity constraints from captured semantic examples", () => {
    const description = generateLocalDescription(endpoint({
      semantic: {
        action_kind: "detail",
        resource_kind: "ticket_bundle",
        example_response_compact: {
          title: "2 Attractions Destination Pass (5-Day)",
          summary:
            "Night Safari and Bird Paradise. This bundle is only applicable to non-residents of Singapore. Comes with 5 days flexibility and one-time access to each attraction.",
        },
      },
      response_schema: {
        type: "object",
        inferred_from_samples: 1,
        properties: {
          parks: { type: "array", inferred_from_samples: 1 },
          validity_days: { type: "number", inferred_from_samples: 1 },
        },
      },
    }));

    expect(description).toContain("non-resident only");
    expect(description).toContain("valid for 5 days");
    expect(description).toContain("one-time entry");
    expect(description).toContain("Night Safari + Bird Paradise");
  });
});
