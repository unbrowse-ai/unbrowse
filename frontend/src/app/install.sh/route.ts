import { NextResponse } from "next/server";

const INSTALL_SH = `#!/usr/bin/env bash
set -euo pipefail

curl -fsSL https://www.unbrowse.ai/install-agent-integrations.sh | bash -s -- "$@"
`;

export function GET() {
  return new NextResponse(INSTALL_SH, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}
