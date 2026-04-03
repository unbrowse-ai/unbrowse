import { NextResponse } from "next/server";
import { MCP_CONFIG_JSON } from "@/lib/install-command";

export async function GET() {
  return new NextResponse(MCP_CONFIG_JSON, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
