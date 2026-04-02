const baseUrl = (process.env.UNBROWSE_BACKEND_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const apiKey = process.env.UNBROWSE_API_KEY;
const targets = process.argv.slice(2);

const endpointMap: Record<string, string> = {
  engagement: "/v1/analytics/engagement",
  retention: "/v1/analytics/retention?days=30",
  activation: "/v1/analytics/activation",
  growth: "/v1/analytics/growth?days=30",
  usage: "/v1/analytics/usage",
  funnel: "/v1/analytics/funnel?days=30",
  network: "/v1/analytics/network",
  economics: "/v1/analytics/economics",
  agents: "/v1/analytics/agents",
  bottleneck: "/v1/analytics/bottleneck",
  pricing: "/v1/analytics/pricing",
  dashboard: "/v1/analytics/dashboard",
  acquisition: "/v1/analytics/acquisition?days=30",
  install: "/v1/analytics/install?days=90",
  "install-funnel": "/v1/analytics/install-funnel?days=90",
};

function usage(): never {
  console.error("Usage: bun skills/internal-analytics/scripts/fetch-analytics.ts <endpoint...>");
  console.error(`Known endpoints: ${Object.keys(endpointMap).join(", ")}`);
  process.exit(1);
}

if (!apiKey) {
  console.error("Missing UNBROWSE_API_KEY");
  process.exit(1);
}

if (targets.length === 0) usage();

const unknown = targets.filter((target) => !endpointMap[target]);
if (unknown.length > 0) {
  console.error(`Unknown endpoint keys: ${unknown.join(", ")}`);
  usage();
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
};

const results = await Promise.all(targets.map(async (target) => {
  const response = await fetch(`${baseUrl}${endpointMap[target]}`, { headers });
  const bodyText = await response.text();
  let body: unknown = bodyText;
  try {
    body = JSON.parse(bodyText);
  } catch {}
  return {
    target,
    url: `${baseUrl}${endpointMap[target]}`,
    status: response.status,
    headers: {
      "cache-control": response.headers.get("cache-control"),
      vary: response.headers.get("vary"),
      "content-type": response.headers.get("content-type"),
    },
    body,
  };
}));

console.log(JSON.stringify(results, null, 2));
