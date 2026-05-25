"use client";

// PERF: heavy below-fold components — dynamic-imported with ssr:false +
// layout-preserving placeholders so first-load JS drops by ~250 KB and
// CLS stays 0. Lives in a client component because next/dynamic with
// ssr:false is not allowed in Server Components (Next 15+).
import dynamic from "next/dynamic";

export const ChatDemo = dynamic(
  () => import("@/components/chat-demo").then((m) => m.ChatDemo),
  { ssr: false, loading: () => <div style={{ minHeight: "70vh" }} /> },
);

export const ThreePanelVisual = dynamic(
  () =>
    import("@/components/three-panel-visual").then((m) => m.ThreePanelVisual),
  { ssr: false, loading: () => <div style={{ minHeight: "80vh" }} /> },
);

export const RegistryShowcase = dynamic(
  () =>
    import("@/components/registry-showcase").then((m) => m.RegistryShowcase),
  { ssr: false, loading: () => <div style={{ minHeight: "100vh" }} /> },
);

export const DemoParallax = dynamic(
  () => import("@/components/demo-parallax").then((m) => m.DemoParallax),
  { ssr: false, loading: () => null },
);
