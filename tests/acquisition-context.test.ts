import { describe, expect, it } from "bun:test";
import {
  extractAcquisitionContext,
  inferIcpFromContext,
  parseAcquisitionContext,
  parseLandingAssignment,
  resolveLandingRequestContext,
  serializeAcquisitionContext,
  serializeLandingAssignment,
} from "../frontend/src/lib/acquisition/context";

describe("acquisition context helpers", () => {
  it("extracts first-touch UTM and click-id context from a landing URL", () => {
    const context = extractAcquisitionContext(
      new URL(
        "https://www.unbrowse.ai/?utm_source=google&utm_medium=cpc&utm_campaign=openclaw_launch&utm_content=plugin_one_command&utm_term=openclaw%20plugin&gclid=test-gclid",
      ),
      "https://www.google.com/search?q=openclaw+plugin",
    );

    expect(context).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "openclaw_launch",
      utm_content: "plugin_one_command",
      utm_term: "openclaw plugin",
      gclid: "test-gclid",
      referrer_host: "www.google.com",
      channel: "google",
      campaign_id: "openclaw_launch",
      content_id: "plugin_one_command",
      inferred_icp: "openclaw-normie",
    });
  });

  it("infers ICP buckets from buyer-language acquisition signals", () => {
    expect(inferIcpFromContext({ utm_term: "playwright alternative" })).toBe("agent-builder");
    expect(inferIcpFromContext({ utm_campaign: "mcp_host_launch" })).toBe("mcp-host");
    expect(inferIcpFromContext({ utm_content: "install one plugin for openclaw" })).toBe("openclaw-normie");
  });

  it("serializes and parses acquisition cookies losslessly enough for routing", () => {
    const encoded = serializeAcquisitionContext({
      utm_source: "x",
      utm_campaign: "agent_builder_launch",
      channel: "x",
      campaign_id: "agent_builder_launch",
      referrer_host: "x.com",
      inferred_icp: "agent-builder",
    });

    expect(parseAcquisitionContext(encoded)).toEqual({
      utm_source: "x",
      utm_campaign: "agent_builder_launch",
      channel: "x",
      campaign_id: "agent_builder_launch",
      referrer_host: "x.com",
      inferred_icp: "agent-builder",
    });
  });

  it("resolves landing assignment precedence from query, cookie, and first-touch context", () => {
    const assignment = parseLandingAssignment(
      serializeLandingAssignment({
        variant_id: "openclaw-normie-v2",
        icp: "openclaw-normie",
        experiment_id: "homepage",
      }),
    );

    const firstTouch = parseAcquisitionContext(
      serializeAcquisitionContext({
        utm_source: "google",
        utm_term: "openclaw plugin",
        inferred_icp: "openclaw-normie",
      }),
    );

    expect(
      resolveLandingRequestContext({
        searchParams: {},
        visitorId: "visitor-123",
        firstTouch,
        assignment,
      }),
    ).toEqual({
      variantId: "openclaw-normie-v2",
      icp: "openclaw-normie",
      experimentId: "homepage",
      seed: "visitor-123",
    });

    expect(
      resolveLandingRequestContext({
        searchParams: {
          variantId: "agent-builder-v1",
          icp: "agent-builder",
          experimentId: "homepage",
          seed: "manual-seed",
        },
        visitorId: "visitor-123",
        firstTouch,
        assignment,
      }),
    ).toEqual({
      variantId: "agent-builder-v1",
      icp: "agent-builder",
      experimentId: "homepage",
      seed: "manual-seed",
    });
  });
});
