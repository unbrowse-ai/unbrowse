"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { trackWebEvent } from "@/lib/web-telemetry";

function inferTrackedContent(pathname: string): { content_id: string; content_type: string } | null {
  if (!pathname || pathname === "/") return null;
  if (pathname === "/privacy" || pathname === "/terms") return null;
  if (pathname === "/blog") return { content_id: "blog", content_type: "blog_index" };
  if (pathname.startsWith("/blog/")) {
    return {
      content_id: pathname.slice("/blog/".length),
      content_type: "blog_article",
    };
  }
  if (pathname.startsWith("/compare/")) {
    return {
      content_id: pathname.slice("/compare/".length),
      content_type: "comparison_page",
    };
  }
  if (typeof document !== "undefined" && document.querySelector("article")) {
    return {
      content_id: pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, ":"),
      content_type: "content_page",
    };
  }
  return null;
}

export function ContentPageTracker() {
  const pathname = usePathname();

  useEffect(() => {
    const content = inferTrackedContent(pathname);
    if (!content) return;
    trackWebEvent("content_page_viewed", content);
  }, [pathname]);

  return null;
}
