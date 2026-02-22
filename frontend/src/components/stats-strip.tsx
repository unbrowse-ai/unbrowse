"use client";

import { useEffect, useState } from "react";

interface Stats {
  skills: number;
  endpoints: number;
  domains: number;
  executions: number;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export function StatsStrip() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/v1/stats/summary`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setStats(data as Stats); })
      .catch(() => {});
  }, []);

  if (!stats) return null;

  // Don't show if everything is zero
  if (stats.skills === 0 && stats.endpoints === 0 && stats.executions === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 sm:gap-8">
      <Stat value={stats.skills} label="Skills indexed" />
      <Stat value={stats.endpoints} label="Endpoints mapped" />
      <Stat value={stats.domains} label="Domains covered" />
      <Stat value={stats.executions} label="Replays executed" />
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="text-center">
      <div className="text-3xl sm:text-4xl font-bold font-mono gradient-text">
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-text-muted font-mono uppercase tracking-wider mt-1">
        {label}
      </div>
    </div>
  );
}
