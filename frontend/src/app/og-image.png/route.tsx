// Brand OG card served at /og-image.png.
//
// 18 page-level metadata blocks (layout.tsx + every long-form landing
// page) reference https://www.unbrowse.ai/og-image.png. The file does
// not exist in public/, so the production server returns HTTP 500 for
// every social share preview. This route handler generates the image
// at request time using next/og's ImageResponse and caches it at the
// edge.

import { ImageResponse } from "next/og";

export const runtime = "edge";

// 24h CDN cache + 7d stale-while-revalidate. The card is static; only
// a deploy of this route should bust the cache.
const CACHE_HEADERS = {
  "cache-control":
    "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
  "content-type": "image/png",
};

export async function GET() {
  const response = new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "space-between",
          // Warm-evening scene per CLAUDE.md design laws: low-chroma
          // neutrals tinted toward brand hue, no pure-black (OKLCH only)
          background:
            "linear-gradient(135deg, #0e1116 0%, #161b22 60%, #1c232d 100%)",
          padding: "80px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "32px",
          }}
        >
          <div
            style={{
              fontSize: 32,
              color: "#7d8590",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            unbrowse.ai
          </div>
          <div
            style={{
              fontSize: 84,
              color: "#f0f6fc",
              fontWeight: 700,
              lineHeight: 1.05,
              maxWidth: 1000,
              letterSpacing: "-0.02em",
            }}
          >
            Reverse-engineer any website into API skills for AI agents.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "48px",
            fontSize: 36,
            color: "#5b8aff",
            fontWeight: 600,
          }}
        >
          <span>100x faster</span>
          <span style={{ color: "#30363d" }}>·</span>
          <span>40x fewer tokens</span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
  for (const [key, value] of Object.entries(CACHE_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}
