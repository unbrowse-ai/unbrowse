import { buildSkillOperationGraph } from "./index.js";
import type { EndpointDescriptor, SkillManifest } from "../types/index.js";

export interface LocalHarnessCase {
  id: string;
  intent: string;
  params?: Record<string, unknown>;
  contextUrl?: string;
  authenticated?: boolean;
  expected_skill_id: string;
  expected_operation_id: string;
  expected_chunk_contains?: string[];
}

function baseSkill(skillId: string, domain: string, endpoints: EndpointDescriptor[]): SkillManifest {
  return {
    skill_id: skillId,
    version: "2.0.0",
    schema_version: "2",
    name: domain,
    intent_signature: domain,
    domain,
    description: `Fixture skill for ${domain}`,
    owner_type: "agent",
    execution_type: "http",
    endpoints,
    operation_graph: buildSkillOperationGraph(endpoints),
    lifecycle: "active",
    created_at: "2026-03-06T00:00:00.000Z",
    updated_at: "2026-03-06T00:00:00.000Z",
    intents: [],
  };
}

function endpoint(
  endpoint_id: string,
  method: EndpointDescriptor["method"],
  url_template: string,
  semantic: NonNullable<EndpointDescriptor["semantic"]>,
): EndpointDescriptor {
  return {
    endpoint_id,
    method,
    url_template,
    description: semantic.description_out,
    idempotency: method === "GET" || method === "WS" ? "safe" : "unsafe",
    verification_status: "verified",
    reliability_score: 0.9,
    trigger_url: `https://${new URL(url_template.replace(/\{[^}]+\}/g, "x")).hostname}`,
    response_schema: {
      type: "object",
      inferred_from_samples: 1,
      properties: Object.fromEntries(
        (semantic.example_fields ?? []).slice(0, 6).map((field) => [
          field.replace(/\[\].*$/, "").split(".").pop() ?? field,
          { type: "string", inferred_from_samples: 1 },
        ])
      ),
    },
    semantic,
  };
}

export function buildLocalHarnessFixtures(): { skills: SkillManifest[]; cases: LocalHarnessCase[] } {
  const discord = baseSkill("fixture-discord", "discord.com", [
    endpoint("discord-guilds", "GET", "https://discord.com/api/v9/users/@me/guilds", {
      action_kind: "list",
      resource_kind: "guild",
      description_in: "No additional inputs required",
      description_out: "Returns the current user's guild list with guild ids and names",
      response_summary: "guilds[].id, guilds[].name",
      example_request: {},
      example_response_compact: { guilds: [{ id: "g1", name: "Agents" }] },
      example_fields: ["guilds[].id", "guilds[].name"],
      requires: [],
      provides: [
        { key: "guild_id", semantic_type: "guild_identifier", source: "response", example_value: "g1" },
        { key: "guild_name", semantic_type: "guild_name", source: "response", example_value: "Agents" },
      ],
      negative_tags: [],
      confidence: 0.95,
      auth_required: true,
    }),
    endpoint("discord-channels", "GET", "https://discord.com/api/v9/guilds/{guild_id}/channels", {
      action_kind: "list",
      resource_kind: "channel",
      description_in: "Requires guild_id",
      description_out: "Returns guild channels with channel ids, names, and types",
      response_summary: "channels[].id, channels[].name, channels[].type",
      example_request: { guild_id: "g1" },
      example_response_compact: { channels: [{ id: "c1", name: "general", type: 0 }] },
      example_fields: ["channels[].id", "channels[].name", "channels[].type"],
      requires: [{ key: "guild_id", semantic_type: "guild_identifier", required: true, source: "url_template" }],
      provides: [
        { key: "channel_id", semantic_type: "channel_identifier", source: "response", example_value: "c1" },
        { key: "channel_name", semantic_type: "channel_name", source: "response", example_value: "general" },
      ],
      negative_tags: [],
      confidence: 0.95,
      auth_required: true,
    }),
    endpoint("discord-messages", "GET", "https://discord.com/api/v9/channels/{channel_id}/messages", {
      action_kind: "list",
      resource_kind: "message",
      description_in: "Requires channel_id",
      description_out: "Returns channel messages with authors and content",
      response_summary: "messages[].id, messages[].content, messages[].author.username",
      example_request: { channel_id: "c1" },
      example_response_compact: { messages: [{ id: "m1", content: "hello", author: { username: "lewis" } }] },
      example_fields: ["messages[].id", "messages[].content", "messages[].author.username"],
      requires: [{ key: "channel_id", semantic_type: "channel_identifier", required: true, source: "url_template" }],
      provides: [{ key: "message_id", semantic_type: "message_identifier", source: "response", example_value: "m1" }],
      negative_tags: [],
      confidence: 0.95,
      auth_required: true,
    }),
    endpoint("discord-experiments", "GET", "https://discord.com/api/v9/experiments?with_guild_experiments={with_guild_experiments}", {
      action_kind: "fetch",
      resource_kind: "config",
      description_in: "Optional with_guild_experiments flag",
      description_out: "Returns experiment assignments and guild experiment flags",
      response_summary: "fingerprint, assignments, guild_experiments",
      example_request: { with_guild_experiments: true },
      example_response_compact: { fingerprint: "abc", assignments: [], guild_experiments: [] },
      example_fields: ["fingerprint", "assignments", "guild_experiments"],
      requires: [{ key: "with_guild_experiments", semantic_type: "flag", required: false, source: "query" }],
      provides: [],
      negative_tags: ["experiment", "config"],
      confidence: 0.9,
      auth_required: true,
    }),
  ]);

  const github = baseSkill("fixture-github", "github.com", [
    endpoint("github-search", "GET", "https://github.com/search?q={q}&type=repositories", {
      action_kind: "search",
      resource_kind: "repository",
      description_in: "Requires q",
      description_out: "Searches repositories and returns names, descriptions, and stars",
      response_summary: "repositories[].full_name, repositories[].description, repositories[].stars",
      example_request: { q: "openai" },
      example_response_compact: { repositories: [{ full_name: "openai/openai-node", stars: 12345 }] },
      example_fields: ["repositories[].full_name", "repositories[].description", "repositories[].stars"],
      requires: [{ key: "q", semantic_type: "query_text", required: true, source: "query" }],
      provides: [
        { key: "owner", semantic_type: "repository_owner", source: "response", example_value: "openai" },
        { key: "repo", semantic_type: "repository_name", source: "response", example_value: "openai-node" },
      ],
      negative_tags: [],
      confidence: 0.95,
    }),
    endpoint("github-repo-detail", "GET", "https://api.github.com/repos/{owner}/{repo}", {
      action_kind: "detail",
      resource_kind: "repository",
      description_in: "Requires owner and repo",
      description_out: "Returns repository details including stars, forks, and description",
      response_summary: "full_name, description, stargazers_count, forks_count",
      example_request: { owner: "openai", repo: "openai-node" },
      example_response_compact: { full_name: "openai/openai-node", stargazers_count: 12345, forks_count: 1000 },
      example_fields: ["full_name", "description", "stargazers_count", "forks_count"],
      requires: [
        { key: "owner", semantic_type: "repository_owner", required: true, source: "url_template" },
        { key: "repo", semantic_type: "repository_name", required: true, source: "url_template" },
      ],
      provides: [{ key: "repo_id", semantic_type: "repository_identifier", source: "response", example_value: "r1" }],
      negative_tags: [],
      confidence: 0.95,
    }),
    endpoint("github-status", "GET", "https://www.githubstatus.com/api/v2/status.json", {
      action_kind: "status",
      resource_kind: "status",
      description_in: "No additional inputs required",
      description_out: "Returns GitHub system status",
      response_summary: "status.indicator, status.description",
      example_request: {},
      example_response_compact: { status: { indicator: "none", description: "All Systems Operational" } },
      example_fields: ["status.indicator", "status.description"],
      requires: [],
      provides: [],
      negative_tags: ["status"],
      confidence: 0.9,
    }),
  ]);

  const marketplace = baseSkill("fixture-market", "example-market.com", [
    endpoint("market-search", "GET", "https://example-market.com/api/search?q={q}", {
      action_kind: "search",
      resource_kind: "listing",
      description_in: "Requires q",
      description_out: "Searches listings and returns listing ids, titles, and prices",
      response_summary: "listings[].listing_id, listings[].title, listings[].price",
      example_request: { q: "bike" },
      example_response_compact: { listings: [{ listing_id: "l1", title: "Road Bike", price: 500 }] },
      example_fields: ["listings[].listing_id", "listings[].title", "listings[].price"],
      requires: [{ key: "q", semantic_type: "query_text", required: true, source: "query" }],
      provides: [{ key: "listing_id", semantic_type: "listing_identifier", source: "response", example_value: "l1" }],
      negative_tags: [],
      confidence: 0.95,
    }),
    endpoint("market-detail", "GET", "https://example-market.com/api/listings/{listing_id}", {
      action_kind: "detail",
      resource_kind: "listing",
      description_in: "Requires listing_id",
      description_out: "Returns listing details including title, price, seller, and description",
      response_summary: "listing.title, listing.price, listing.seller, listing.description",
      example_request: { listing_id: "l1" },
      example_response_compact: { listing: { title: "Road Bike", price: 500, seller: "Sam" } },
      example_fields: ["listing.title", "listing.price", "listing.seller", "listing.description"],
      requires: [{ key: "listing_id", semantic_type: "listing_identifier", required: true, source: "url_template" }],
      provides: [],
      negative_tags: [],
      confidence: 0.95,
    }),
  ]);

  const linkedin = baseSkill("fixture-linkedin", "linkedin.com", [
    endpoint("linkedin-search-people", "GET", "https://www.linkedin.com/voyager/api/search/people?q={q}", {
      action_kind: "search",
      resource_kind: "profile",
      description_in: "Requires q",
      description_out: "Searches people and returns profile ids, names, and headlines",
      response_summary: "profiles[].public_identifier, profiles[].name, profiles[].headline",
      example_request: { q: "openai" },
      example_response_compact: { profiles: [{ public_identifier: "sam-altman", name: "Sam Altman", headline: "CEO" }] },
      example_fields: ["profiles[].public_identifier", "profiles[].name", "profiles[].headline"],
      requires: [{ key: "q", semantic_type: "query_text", required: true, source: "query" }],
      provides: [{ key: "public_identifier", semantic_type: "profile_identifier", source: "response", example_value: "sam-altman" }],
      negative_tags: [],
      confidence: 0.95,
      auth_required: true,
    }),
    endpoint("linkedin-profile-detail", "GET", "https://www.linkedin.com/voyager/api/identity/profiles/{public_identifier}", {
      action_kind: "detail",
      resource_kind: "profile",
      description_in: "Requires public_identifier",
      description_out: "Returns profile details including name, headline, and experience",
      response_summary: "profile.name, profile.headline, profile.experience",
      example_request: { public_identifier: "sam-altman" },
      example_response_compact: { profile: { name: "Sam Altman", headline: "CEO", experience: ["OpenAI"] } },
      example_fields: ["profile.name", "profile.headline", "profile.experience"],
      requires: [{ key: "public_identifier", semantic_type: "profile_identifier", required: true, source: "url_template" }],
      provides: [],
      negative_tags: [],
      confidence: 0.95,
      auth_required: true,
    }),
  ]);

  const formPage = {
    ...endpoint("jobs-form-options", "GET", "https://jobs.example.com/roles", {
      action_kind: "list",
      resource_kind: "form",
      description_in: "No additional inputs required",
      description_out: "Returns form dropdown options for department and location filters",
      response_summary: "department_options[].label, department_options[].value, location_options[].label, location_options[].value",
      example_request: {},
      example_response_compact: {
        department_options: [{ label: "Engineering", value: "eng" }],
        location_options: [{ label: "Remote", value: "remote" }],
      },
      example_fields: [
        "department_options[].label",
        "department_options[].value",
        "location_options[].label",
        "location_options[].value",
      ],
      requires: [],
      provides: [
        { key: "department", semantic_type: "department_option", source: "response", example_value: "eng" },
        { key: "location", semantic_type: "location_option", source: "response", example_value: "remote" },
      ],
      negative_tags: [],
      confidence: 0.95,
    }),
    dom_extraction: {
      extraction_method: "form-options",
      confidence: 0.95,
      selector: "form[data-role='job-search']",
    },
  } satisfies EndpointDescriptor;

  const formSearch = endpoint("jobs-search", "GET", "https://jobs.example.com/api/jobs?department={department}&location={location}", {
    action_kind: "search",
    resource_kind: "job",
    description_in: "Requires department and location",
    description_out: "Searches jobs using the selected form filters",
    response_summary: "jobs[].job_id, jobs[].title, jobs[].location",
    example_request: { department: "eng", location: "remote" },
    example_response_compact: { jobs: [{ job_id: "j1", title: "Staff Engineer", location: "Remote" }] },
    example_fields: ["jobs[].job_id", "jobs[].title", "jobs[].location"],
    requires: [
      { key: "department", semantic_type: "department_option", required: true, source: "query" },
      { key: "location", semantic_type: "location_option", required: true, source: "query" },
    ],
    provides: [{ key: "job_id", semantic_type: "job_identifier", source: "response", example_value: "j1" }],
    negative_tags: [],
    confidence: 0.95,
  });

  const formDetail = endpoint("job-detail", "GET", "https://jobs.example.com/api/jobs/{job_id}", {
    action_kind: "detail",
    resource_kind: "job",
    description_in: "Requires job_id",
    description_out: "Returns job details for the selected listing",
    response_summary: "job.title, job.team, job.description",
    example_request: { job_id: "j1" },
    example_response_compact: { job: { title: "Staff Engineer", team: "Platform", description: "..." } },
    example_fields: ["job.title", "job.team", "job.description"],
    requires: [{ key: "job_id", semantic_type: "job_identifier", required: true, source: "url_template" }],
    provides: [],
    negative_tags: [],
    confidence: 0.95,
  });

  const formDriven = baseSkill("fixture-form-html", "jobs.example.com", [
    formPage,
    formSearch,
    formDetail,
  ]);

  const skills = [discord, github, marketplace, linkedin, formDriven];
  const cases: LocalHarnessCase[] = [
    {
      id: "discord-root-channels",
      intent: "get guild channels",
      authenticated: true,
      expected_skill_id: "fixture-discord",
      expected_operation_id: "discord-guilds",
      expected_chunk_contains: ["discord-channels"],
    },
    {
      id: "discord-bound-channels",
      intent: "get guild channels",
      params: { guild_id: "g1" },
      authenticated: true,
      expected_skill_id: "fixture-discord",
      expected_operation_id: "discord-channels",
      expected_chunk_contains: ["discord-guilds", "discord-channels"],
    },
    {
      id: "github-search",
      intent: "search repositories",
      params: { q: "openai" },
      expected_skill_id: "fixture-github",
      expected_operation_id: "github-search",
      expected_chunk_contains: ["github-repo-detail"],
    },
    {
      id: "market-search",
      intent: "search listings",
      params: { q: "bike" },
      expected_skill_id: "fixture-market",
      expected_operation_id: "market-search",
      expected_chunk_contains: ["market-detail"],
    },
    {
      id: "market-detail",
      intent: "get listing details",
      params: { listing_id: "l1" },
      expected_skill_id: "fixture-market",
      expected_operation_id: "market-detail",
      expected_chunk_contains: ["market-search", "market-detail"],
    },
    {
      id: "linkedin-profile-detail",
      intent: "get profile details",
      params: { public_identifier: "sam-altman" },
      authenticated: true,
      expected_skill_id: "fixture-linkedin",
      expected_operation_id: "linkedin-profile-detail",
      expected_chunk_contains: ["linkedin-search-people", "linkedin-profile-detail"],
    },
    {
      id: "html-form-options",
      intent: "get form options",
      contextUrl: "https://jobs.example.com/roles",
      expected_skill_id: "fixture-form-html",
      expected_operation_id: "jobs-form-options",
      expected_chunk_contains: ["jobs-search"],
    },
    {
      id: "html-form-search",
      intent: "search jobs",
      params: { department: "eng", location: "remote" },
      contextUrl: "https://jobs.example.com/roles",
      expected_skill_id: "fixture-form-html",
      expected_operation_id: "jobs-search",
      expected_chunk_contains: ["jobs-form-options", "job-detail"],
    },
  ];

  return { skills, cases };
}
