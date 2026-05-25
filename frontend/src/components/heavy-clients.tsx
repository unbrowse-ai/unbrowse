"use client";

// PERF: heavy below-fold components — dynamic-imported with ssr:false +
// layout-preserving placeholders SIZED to match the components'
// actual rendered heights so the swap is reflow-free. Heights were
// measured in-browser at 1440x900: ChatDemo ~614 (its parent
// #demo carries py-16/24), ThreePanelVisual uses min-h-screen
// (100vh), RegistryShowcase uses h-screen (100vh). Each placeholder
// also carries `contain: layout` so any internal reflow on mount
// can't bubble out of the host box.
//
// Lives in a client component because next/dynamic with ssr:false is
// not allowed in Server Components (Next 15+).
import dynamic from "next/dynamic";

const placeholder = (h: string): React.CSSProperties => ({
  minHeight: h,
  contain: "layout",
});

export const ChatDemo = dynamic(
  () => import("@/components/chat-demo").then((m) => m.ChatDemo),
  {
    ssr: false,
    // ChatDemo renders inside #demo section (py-16/24) — actual content
    // box ~450-500px on desktop; 60vh leaves a small safety margin.
    loading: () => <div aria-hidden style={placeholder("60vh")} />,
  },
);

export const ThreePanelVisual = dynamic(
  () =>
    import("@/components/three-panel-visual").then((m) => m.ThreePanelVisual),
  {
    ssr: false,
    // ThreePanelVisual section uses `min-h-screen` (100vh).
    loading: () => <div aria-hidden style={placeholder("100vh")} />,
  },
);

export const RegistryShowcase = dynamic(
  () =>
    import("@/components/registry-showcase").then((m) => m.RegistryShowcase),
  {
    ssr: false,
    // RegistryShowcase section uses `h-screen` (100vh). max-sm collapses
    // to auto, but on mobile the placeholder is below first viewport so
    // a temporary over-size doesn't shift first paint.
    loading: () => <div aria-hidden style={placeholder("100vh")} />,
  },
);

export const DemoParallax = dynamic(
  () => import("@/components/demo-parallax").then((m) => m.DemoParallax),
  { ssr: false, loading: () => null },
);
