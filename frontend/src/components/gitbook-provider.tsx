"use client";

import dynamic from "next/dynamic";

const GitBookEmbedProvider = dynamic(
  () =>
    import("./gitbook-provider.client").then(
      (mod) => mod.GitBookEmbedProvider,
    ),
  { ssr: false },
);

export function GitBookProviderBoundary({
  children,
}: {
  children: React.ReactNode;
}) {
  return <GitBookEmbedProvider>{children}</GitBookEmbedProvider>;
}
