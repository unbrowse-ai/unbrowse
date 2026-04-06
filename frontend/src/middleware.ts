import { NextResponse, type NextRequest } from "next/server";

const VISITOR_COOKIE = "unbrowse_lp_visitor";
const ASSIGNMENT_COOKIE = "unbrowse_lp_assignment";
const ASSIGNMENT_HEADER = "x-unbrowse-landing-assignment";

function resolveApiUrl(request: NextRequest): string {
  const host = request.nextUrl.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  if (isLocal) {
    return `${request.nextUrl.protocol}//${host === "0.0.0.0" ? "localhost" : host}:8787`;
  }
  return process.env.NEXT_PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";
}

function encodeHeaderPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  const base64 = btoa(json);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname !== "/") {
    return NextResponse.next();
  }

  const visitorId = request.cookies.get(VISITOR_COOKIE)?.value ?? crypto.randomUUID();
  const currentAssignment = request.cookies.get(ASSIGNMENT_COOKIE)?.value ?? null;

  try {
    const res = await fetch(`${resolveApiUrl(request)}/v1/landing/homepage/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitor_id: visitorId,
        current_assignment: currentAssignment,
      }),
    });

    if (!res.ok) {
      const fallback = NextResponse.next();
      fallback.cookies.set(VISITOR_COOKIE, visitorId, { path: "/", httpOnly: false, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
      return fallback;
    }

    const data = await res.json() as {
      assignment_cookie: string;
      assignment: { experiment_id: string; variant_id: string; assigned_at: string };
      content: unknown;
      status: string;
    };

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(ASSIGNMENT_HEADER, encodeHeaderPayload({
      assignment: data.assignment,
      content: data.content,
      status: data.status,
    }));

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.cookies.set(VISITOR_COOKIE, visitorId, { path: "/", httpOnly: false, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
    response.cookies.set(ASSIGNMENT_COOKIE, data.assignment_cookie, { path: "/", httpOnly: false, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
    return response;
  } catch {
    const fallback = NextResponse.next();
    fallback.cookies.set(VISITOR_COOKIE, visitorId, { path: "/", httpOnly: false, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
    return fallback;
  }
}

export const config = {
  matcher: ["/"],
};
