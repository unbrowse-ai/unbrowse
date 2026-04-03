"use client";

import { useEffect } from "react";
import { trackWebEvent } from "@/lib/web-telemetry";

interface Props {
  experimentId: string;
  variantId: string;
}

export function AcquisitionTracker({ experimentId, variantId }: Props) {
  useEffect(() => {
    const context = { experimentId, variantId };
    const trackedScrollBuckets = new Set<number>();
    const trackedSections = new Set<string>();
    const explorationTargets = new Set<string>();
    const explorationSections = new Set<string>();

    const emitExplorationDepth = () => {
      trackWebEvent("page_exploration_depth_updated", {
        depth: explorationTargets.size + explorationSections.size,
      }, context);
    };

    const markSection = (sectionId: string) => {
      if (trackedSections.has(sectionId)) return;
      trackedSections.add(sectionId);
      explorationSections.add(sectionId);
      trackWebEvent("section_viewed", { section_id: sectionId }, context);
      if (sectionId === "install") {
        trackWebEvent("install_section_viewed", { section_id: sectionId }, context);
      }
      if (sectionId === "first-task") {
        trackWebEvent("first_task_section_viewed", { section_id: sectionId }, context);
      }
      emitExplorationDepth();
    };

    const maybeTrackScroll = () => {
      const scrollTop = window.scrollY;
      const viewport = window.innerHeight;
      const height = document.documentElement.scrollHeight;
      const depth = height <= viewport ? 100 : ((scrollTop + viewport) / height) * 100;
      for (const bucket of [25, 50, 75, 90]) {
        if (depth < bucket || trackedScrollBuckets.has(bucket)) continue;
        trackedScrollBuckets.add(bucket);
        trackWebEvent("scroll_depth_reached", { bucket }, context);
      }
    };

    trackWebEvent("landing_page_viewed", undefined, context);
    trackWebEvent("hero_viewed", undefined, context);
    maybeTrackScroll();

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const sectionId = entry.target.getAttribute("data-landing-section");
          if (sectionId) markSection(sectionId);
        }
      }, { threshold: 0.45 });

      for (const sectionId of ["install", "demo", "registry", "faq", "first-task"]) {
        const target = document.getElementById(sectionId);
        if (!target) continue;
        target.setAttribute("data-landing-section", sectionId);
        observer.observe(target);
      }
    }

    const onScroll = () => maybeTrackScroll();
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-exploration-id]") : null;
      const explorationId = target?.dataset.explorationId;
      if (!explorationId || explorationTargets.has(explorationId)) return;
      explorationTargets.add(explorationId);
      trackWebEvent("exploration_page_clicked", { target_id: explorationId }, context);
      emitExplorationDepth();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("click", onClick);

    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("click", onClick);
    };
  }, [experimentId, variantId]);

  return null;
}
