import type { Metadata } from "next";
import { OpsLoader } from "./loader";

export const metadata: Metadata = {
  title: "OPS // unbrowse",
  robots: "noindex, nofollow",
};

export default function OpsPage() {
  return <OpsLoader />;
}
