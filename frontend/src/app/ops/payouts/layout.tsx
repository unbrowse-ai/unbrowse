import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Payouts // unbrowse ops",
  robots: "noindex, nofollow",
};

export default function PayoutsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
