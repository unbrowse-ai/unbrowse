'use client';

import { useEffect } from 'react';
import { track } from '@/lib/umami';

// Fires a single `landing_visit` umami event when the landing page mounts.
// Umami auto-tracks pageviews; this is the explicit funnel event the
// build-end-to-end-funnel-tracking-for-unbrowse-ev plan_text declares as
// the second-from-top funnel layer (after X impression → landing visit).
// The event lets us join landing arrivals with downstream install_cta_click
// + setup_completed + first_capture without depending on Umami's pageview
// shape changing.
export function LandingVisitTracker() {
  useEffect(() => {
    track('landing_visit', { path: window.location.pathname });
  }, []);
  return null;
}
