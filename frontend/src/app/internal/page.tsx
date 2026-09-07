import type { Metadata } from "next";
import { InternalDashboard } from "./dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Signal Room | Unbrowse",
  robots: { index: false, follow: false, nocache: true },
};

export default function InternalPage() {
  return <InternalDashboard />;
}
