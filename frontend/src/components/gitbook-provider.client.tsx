"use client";

import { GitBookProvider } from "@gitbook/embed/react";

export function GitBookEmbedProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <GitBookProvider siteURL="https://getfoundry.gitbook.io/unbrowse">
      {children}
    </GitBookProvider>
  );
}
