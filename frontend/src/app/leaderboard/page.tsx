"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LeaderboardRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/miners");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center text-text-muted text-sm">
      Redirecting to miners leaderboard...
    </div>
  );
}
