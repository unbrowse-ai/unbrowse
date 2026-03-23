const WHITEPAPER_SOURCE_URL =
  "https://raw.githubusercontent.com/unbrowse-ai/unbrowse/stable/docs/whitepaper/unbrowse-whitepaper.pdf";

export async function GET() {
  const response = await fetch(WHITEPAPER_SOURCE_URL, {
    next: { revalidate: 3600 },
  });

  if (!response.ok) {
    return new Response("Whitepaper unavailable", { status: 502 });
  }

  return new Response(response.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": 'inline; filename="unbrowse-whitepaper.pdf"',
      "cache-control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
