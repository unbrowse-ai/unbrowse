interface LandingVariantPayload {
  variant_id?: string;
  slug?: string;
  name: string;
  icp: string;
  experiment_id?: string;
  status?: "draft" | "active" | "archived";
  weight?: number;
  notes?: string;
  content?: {
    hero_eyebrow?: string;
    hero_title?: string;
    hero_highlight?: string;
    hero_body?: string;
    hero_supporting?: string;
    trust_items?: string[];
    definition_title?: string;
    definition_body?: string;
    install_summary?: string;
  };
}

function usage() {
  console.log(`Usage:

  bun scripts/publish-landing-variant.ts <file.json> [--api-base https://beta-api.unbrowse.ai/v1]

Env:

  UNBROWSE_LANDING_PUBLISH_KEY or LANDING_PUBLISH_KEY   required
  UNBROWSE_LANDING_API_BASE                             optional override
`);
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || file === "--help" || file === "-h") {
    usage();
    process.exit(file ? 0 : 1);
  }

  let apiBase = process.env.UNBROWSE_LANDING_API_BASE ?? "https://beta-api.unbrowse.ai/v1";
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--api-base" && rest[i + 1]) {
      apiBase = rest[i + 1];
      i += 1;
    }
  }

  const key = process.env.UNBROWSE_LANDING_PUBLISH_KEY ?? process.env.LANDING_PUBLISH_KEY;
  if (!key) throw new Error("Missing UNBROWSE_LANDING_PUBLISH_KEY or LANDING_PUBLISH_KEY");

  const payload = JSON.parse(await Bun.file(file).text()) as LandingVariantPayload;
  if (!payload?.name || !payload?.icp) throw new Error("Payload must include name and icp");

  const res = await fetch(`${apiBase}/landing/variants/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Publish failed (${res.status}): ${text}`);
  console.log(text);
}

await main();
