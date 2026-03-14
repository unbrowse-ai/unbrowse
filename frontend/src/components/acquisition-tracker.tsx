"use client";

import { useEffect } from "react";
import { trackWebEvent } from "@/lib/web-telemetry";

export function AcquisitionTracker() {
  useEffect(() => {
    trackWebEvent("landing_page_viewed");

    const target = document.getElementById("install");
    if (!target || typeof IntersectionObserver === "undefined") return;

    let tracked = false;
    const observer = new IntersectionObserver((entries) => {
      if (tracked) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        tracked = true;
        trackWebEvent("install_section_viewed", {
          section_id: "install",
        });
        observer.disconnect();
        break;
      }
    }, { threshold: 0.4 });

    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return null;
}
