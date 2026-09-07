/** Bee-alias branding — shared strings for pollen-cli bins and install noise. */

export const HIVE = "unbrowse";

export const ALIASES = {
  pollen: {
    tagline: "collect routes from the web",
    emoji: "🌼",
    verb: "forage",
  },
  waggle: {
    tagline: "dance the cache hit to the hive",
    emoji: "💃",
    verb: "replay",
  },
  buzz: {
    tagline: "fast path — you heard it before the browser did",
    emoji: "⚡",
    verb: "ping",
  },
  forage: {
    tagline: "go find what the site hides behind the DOM",
    emoji: "🔍",
    verb: "capture",
  },
  swarm: {
    tagline: "many agents, one indexed hive",
    emoji: "🐝",
    verb: "mesh",
  },
  nectar: {
    tagline: "sweet cached API — drink the route",
    emoji: "🍯",
    verb: "sip",
  },
  hive: {
    tagline: "home base — same runtime, louder jacket",
    emoji: "🏠",
    verb: "setup",
  },
};

export function aliasMeta(name) {
  const key = String(name || "pollen").toLowerCase();
  return ALIASES[key] ?? { tagline: "bee-alias for unbrowse", emoji: "🐝", verb: "go" };
}

export function installBanner(version = "unknown") {
  const lines = [
    "",
    "  🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝",
    "  POLLEN HIVE ONLINE — @unbrowse/pollen-cli@" + version,
    "  Same unbrowse runtime. Memey bins. Maximum buzz.",
    "",
    "  bins: pollen · waggle · buzz · forage · swarm · nectar · hive",
    "  try:  pollen setup",
    "        forage \"top stories\" --url https://news.ycombinator.com",
    "        buzz --version",
    "",
    "  npm:  @unbrowse/pollen-cli  (this package)",
    "  hive: unbrowse             (the engine underneath)",
    "  🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝🐝",
    "",
  ];
  return lines.join("\n");
}

export function versionLine(installedVersion, alias) {
  const meta = aliasMeta(alias);
  return `${installedVersion} ${meta.emoji} ${alias} → ${HIVE} (${meta.tagline})`;
}

export function helpBeeLine() {
  return [
    "",
    "Bee aliases (same runtime, louder names):",
    "  npm i -g @unbrowse/pollen-cli",
    "  pollen | waggle | buzz | forage | swarm | nectar | hive  — all map to unbrowse",
    "",
  ].join("\n");
}