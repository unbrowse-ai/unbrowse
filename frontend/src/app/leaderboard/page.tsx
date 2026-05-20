import { permanentRedirect } from "next/navigation";

// Bookmark-rescue for users who saved /leaderboard. The canonical route is
// /miners (the navbar's "Leaderboard" label resolves there). Use a Next.js
// server-side permanent redirect (HTTP 308) instead of a client-side
// useRouter.replace so AI crawlers, SEO, and `unbrowse_fetch` agents get the
// right destination on the first hop without a render flash.
export default function LeaderboardRedirect(): never {
  permanentRedirect("/miners");
}
