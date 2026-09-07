"use client";

import { useEffect } from "react";

/**
 * EditionsPageBodyClass — adds `editions-page` to <body> for the duration
 * of the landing mount, then removes it on unmount. Used to flip the
 * global dark theme into the cream editions surface for `/` only without
 * touching app/layout.tsx (which serves every other route in dark/orange).
 */
export function EditionsPageBodyClass() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.add("editions-page");
    return () => {
      document.body.classList.remove("editions-page");
    };
  }, []);
  return null;
}
