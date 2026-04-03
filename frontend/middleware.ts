import { NextRequest, NextResponse } from "next/server";
import {
  extractAcquisitionContext,
  FIRST_TOUCH_COOKIE,
  hasAcquisitionSignals,
  inferIcpFromContext,
  LANDING_ASSIGNMENT_COOKIE,
  parseAcquisitionContext,
  parseLandingAssignment,
  serializeAcquisitionContext,
  VISITOR_ID_COOKIE,
} from "./src/lib/acquisition/context";

const THIRTY_DAYS = 60 * 60 * 24 * 30;
const ONE_YEAR = 60 * 60 * 24 * 365;

export function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);

  const visitorId = request.cookies.get(VISITOR_ID_COOKIE)?.value ?? crypto.randomUUID();
  requestHeaders.set("x-unbrowse-visitor-id", visitorId);

  const existingFirstTouch = parseAcquisitionContext(request.cookies.get(FIRST_TOUCH_COOKIE)?.value);
  const extracted = extractAcquisitionContext(request.nextUrl, request.headers.get("referer"));
  const inferredIcp = existingFirstTouch?.inferred_icp ?? inferIcpFromContext(extracted);
  if (inferredIcp) requestHeaders.set("x-unbrowse-inferred-icp", inferredIcp);

  const assignment = parseLandingAssignment(request.cookies.get(LANDING_ASSIGNMENT_COOKIE)?.value);
  if (assignment?.variant_id) requestHeaders.set("x-unbrowse-assigned-variant-id", assignment.variant_id);
  if (assignment?.icp) requestHeaders.set("x-unbrowse-assigned-icp", assignment.icp);
  if (assignment?.experiment_id) requestHeaders.set("x-unbrowse-assigned-experiment-id", assignment.experiment_id);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (!request.cookies.get(VISITOR_ID_COOKIE)?.value) {
    response.cookies.set(VISITOR_ID_COOKIE, visitorId, {
      path: "/",
      sameSite: "lax",
      maxAge: ONE_YEAR,
    });
  }

  if (!existingFirstTouch && hasAcquisitionSignals(extracted)) {
    response.cookies.set(FIRST_TOUCH_COOKIE, serializeAcquisitionContext(extracted), {
      path: "/",
      sameSite: "lax",
      maxAge: THIRTY_DAYS,
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|json|woff|woff2|ttf|otf)$).*)"],
};
