import { describe, expect, it } from "bun:test";
import { decodeTelemetryAttribution } from "../src/telemetry-attribution.js";
import { decorateInstallCommandWithAttribution } from "../frontend/src/lib/acquisition/install-attribution";

describe("install attribution command decoration", () => {
  it("injects attribution into curl-to-bash installers", () => {
    const command = decorateInstallCommandWithAttribution(
      "curl -fsSL https://unbrowse.ai/install.sh | bash",
      {
        channel: "x",
        campaign_id: "openclaw-launch",
        content_id: "x-post-42",
        variant_id: "openclaw-normie-v2",
      },
    );

    expect(command).toContain("UNBROWSE_ATTRIBUTION_B64='");
    const encoded = command.match(/UNBROWSE_ATTRIBUTION_B64='([^']+)'/)?.[1];
    expect(encoded).toBeTruthy();
    expect(decodeTelemetryAttribution(encoded)).toEqual({
      channel: "x",
      campaign_id: "openclaw-launch",
      content_id: "x-post-42",
      variant_id: "openclaw-normie-v2",
    });
  });

  it("prefixes non-piped install commands with env attribution", () => {
    const command = decorateInstallCommandWithAttribution(
      "npx unbrowse-openclaw install --restart",
      {
        channel: "meta",
        campaign_id: "plugin-install",
      },
    );

    expect(command.startsWith("env UNBROWSE_ATTRIBUTION_B64='")).toBe(true);
    expect(command).toContain(" npx unbrowse-openclaw install --restart");
  });
});
