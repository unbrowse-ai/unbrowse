"use client";

import { useEffect } from "react";
import { trackWebEvent } from "@/lib/web-telemetry";

export function AcquisitionTracker() {
  useEffect(() => {
    trackWebEvent("landing_page_viewed");

    if (typeof IntersectionObserver === "undefined") return;

    const tracked = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const sectionId = entry.target.getAttribute("id");
        if (!sectionId || tracked.has(sectionId)) continue;
        tracked.add(sectionId);
        if (sectionId === "install") {
          trackWebEvent("install_section_viewed", { section_id: sectionId });
        }
        if (sectionId === "first-task") {
          trackWebEvent("first_task_section_viewed", { section_id: sectionId });
        }
      }
    }, { threshold: 0.4 });

    for (const sectionId of ["install", "first-task"]) {
      const target = document.getElementById(sectionId);
      if (target) observer.observe(target);
    }

    return () => observer.disconnect();
  }, []);

  return null;
}
