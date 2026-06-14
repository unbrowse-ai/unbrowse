import { describe, expect, it } from "bun:test";
import { getConfiguredApiOrigin, getConfiguredApiV1Origin } from "../frontend/src/lib/api-base";
import { GET as getMcpJson } from "../frontend/src/app/mcp.json/route";
import { GET as getSkillMd } from "../frontend/src/app/skill.md/route";

describe("frontend API and CLI wiring", () => {
  it("uses the configured frontend API origin and accepts the legacy base-url env name", () => {
    expect(getConfiguredApiOrigin({ NEXT_PUBLIC_API_URL: "https://api.example.com/" })).toBe("https://api.example.com");
    expect(getConfiguredApiOrigin({ NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:8787/" })).toBe("http://127.0.0.1:8787");
    expect(getConfiguredApiV1Origin({ NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:8787/" })).toBe("http://127.0.0.1:8787/v1");
    expect(getConfiguredApiV1Origin({ NEXT_PUBLIC_API_URL: "https://api.example.com/v1" })).toBe("https://api.example.com/v1");
  });

  it("keeps the public skill instructions aligned with Skill/CLI install, not MCP autoinstall", async () => {
    const response = await getSkillMd();
    const body = await response.text();

    expect(body).toContain("npm install -g unbrowse");
    expect(body).toContain("unbrowse setup");
    expect(body).toContain("Agent Skill / CLI");
    expect(body).not.toContain("mcpServers");
    expect(body).not.toContain("unbrowse setup --host mcp");
    expect(body).not.toContain("auto-registers as an agent");
    expect(body).not.toContain("captures the site, reverse-engineers the API, publishes the skill");
    expect(body).not.toContain("unbrowse wallet setup");
  });

  it("does not publish an auto-install MCP config endpoint", async () => {
    const response = await getMcpJson();
    const body = await response.text();

    expect(response.status).toBe(410);
    expect(body).toContain("mcp_autoinstall_removed");
    expect(body).not.toContain("mcpServers");
  });
});
