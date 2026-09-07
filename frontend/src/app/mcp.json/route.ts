import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    error: "mcp_autoinstall_removed",
    message: "Unbrowse no longer publishes an auto-install MCP config. Use the Agent Skill/CLI install path; the legacy `unbrowse mcp` server remains manual-only.",
  }, {
    status: 410,
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
