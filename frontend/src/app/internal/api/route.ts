import { getConfiguredApiOrigin } from "@/lib/api-base";

export const dynamic = "force-dynamic";

function unauthorized(): Response {
  return Response.json(
    { error: "Authentication required" },
    {
      status: 401,
      headers: {
        "Cache-Control": "private, no-store",
        "WWW-Authenticate": 'Basic realm="unbrowse internal", charset="UTF-8"',
      },
    },
  );
}

function basicPassword(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : null;
  } catch {
    return null;
  }
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Same-origin bridge from the edge-password-gated page to the private backend.
 * The dashboard password never enters client JavaScript or localStorage.
 */
export async function GET(request: Request): Promise<Response> {
  const password = process.env.INTERNAL_AUTH_PASSWORD?.trim();
  const provided = basicPassword(request.headers.get("authorization"));
  if (!password || !provided || !timingSafeEqual(provided, password)) return unauthorized();

  const requestUrl = new URL(request.url);
  const requestedDays = Number(requestUrl.searchParams.get("days") ?? 90);
  const days = Math.max(7, Math.min(180, Math.trunc(Number.isFinite(requestedDays) ? requestedDays : 90)));
  const endpoint = `${getConfiguredApiOrigin()}/v1/analytics/internal?days=${days}`;

  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${password}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
        Vary: "Authorization",
      },
    });
  } catch {
    return Response.json(
      { error: "Internal analytics backend unavailable" },
      { status: 502, headers: { "Cache-Control": "private, no-store", Vary: "Authorization" } },
    );
  }
}
