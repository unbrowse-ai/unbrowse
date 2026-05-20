import type { Metadata } from "next";
import { FunnelFailuresLoader } from "./loader";

export const metadata: Metadata = {
  title: "OPS // funnel-failures // unbrowse",
  robots: "noindex, nofollow",
};

export default function FunnelFailuresPage() {
  return <FunnelFailuresLoader />;
}
