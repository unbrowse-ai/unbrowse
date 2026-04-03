"use client";

import { useEffect } from "react";
import { trackWebEvent } from "@/lib/web-telemetry";

export function AcquisitionTracker() {
  useEffect(() => {
    trackWebEvent("landing_page_viewed");

    if (typeof IntersectionObserver === "undefined") return;

    const sections = [
      { id: "icp-paths", event: "landing_section_viewed", threshold: 0.35 },
      { id: "install", event: "install_section_viewed", threshold: 0.4 },
      { id: "how-it-works", event: "landing_section_viewed", threshold: 0.35 },
      { id: "registry", event: "landing_section_viewed", threshold: 0.35 },
      { id: "works-with", event: "landing_section_viewed", threshold: 0.35 },
      { id: "demo", event: "landing_section_viewed", threshold: 0.35 },
      { id: "post-install", event: "landing_section_viewed", threshold: 0.35 },
      { id: "faq", event: "landing_section_viewed", threshold: 0.35 },
    ] as const;

    const tracked = new Set<string>();
    const observers: IntersectionObserver[] = [];

    for (const section of sections) {
      const target = document.getElementById(section.id);
      if (!target) continue;
      const observer = new IntersectionObserver((entries) => {
        if (tracked.has(section.id)) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          tracked.add(section.id);
          trackWebEvent(section.event, {
            section_id: section.id,
          });
          observer.disconnect();
          break;
        }
      }, { threshold: section.threshold });
      observer.observe(target);
      observers.push(observer);
    }

    return () => {
      for (const observer of observers) observer.disconnect();
    };
  }, []);

  return null;
}
