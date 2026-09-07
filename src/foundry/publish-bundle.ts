import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type FoundryHost = "codex" | "claude" | "openclaw";

export type FoundryPreset = {
  bundle_id: string;
  title: string;
  fabric?: {
    repo?: string;
    skill?: string;
  };
  repo?: string;
  bootstrap_skill?: string;
  skills?: string[];
  skill_sources?: Record<string, {
    repo?: string;
    install?: string;
    source_path?: string;
  }>;
  dependency_graph?: {
    nodes?: Array<Record<string, unknown>>;
  };
  routes?: Array<{
    when: string;
    call: string;
  }>;
  tool_routing?: Record<string, unknown>;
  share?: {
    transport?: string;
    manifest_path?: string;
  };
  index?: {
    slug?: string;
    summary?: string;
    tags?: string[];
  };
};

export type PublishFoundryBundleInput = {
  preset?: FoundryPreset;
  presetPath?: string;
  repoRoot?: string;
  siteUrl?: string;
  hosts?: FoundryHost[];
};

export type PublishFoundryBundleResult = {
  ok: true;
  bundle_id: string;
  preset_path?: string;
  bundle_dir: string;
  public_manifest_path: string;
  public_url: string;
  files: {
    bundle: string;
    registry_entry: string;
    share: string;
    candidate_skills: string;
    action_dag: string;
    next_action_dataset: string;
    tool_routing_report: string;
    host_snippets: Record<string, string>;
  };
};

const DEFAULT_FOUNDARY_INSTALL = "npx skills add https://github.com/unbrowse-ai/foundry --skill foundry --yes";
const DEFAULT_SITE_URL = "https://www.unbrowse.ai";
const DEFAULT_HOSTS: FoundryHost[] = ["codex", "claude", "openclaw"];

const HOST_TARGETS: Record<FoundryHost, { target_path: string; snippet_path: string; filename: string }> = {
  codex: {
    target_path: "./AGENTS.md",
    snippet_path: "hosts/codex/AGENTS.md",
    filename: "AGENTS.md",
  },
  claude: {
    target_path: "./CLAUDE.md",
    snippet_path: "hosts/claude/CLAUDE.md",
    filename: "CLAUDE.md",
  },
  openclaw: {
    target_path: "./MEMORY.md",
    snippet_path: "hosts/openclaw/MEMORY.md",
    filename: "MEMORY.md",
  },
};

function ensureObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function ensureBundleId(value: unknown): string {
  const bundleId = typeof value === "string" ? value.trim() : "";
  if (!bundleId) throw new Error("Foundry preset requires bundle_id");
  return bundleId;
}

function ensureTitle(value: unknown, bundleId: string): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) throw new Error(`Foundry preset ${bundleId} requires title`);
  return title;
}

function normalizeHosts(hosts?: FoundryHost[]): FoundryHost[] {
  if (!hosts || hosts.length === 0) return [...DEFAULT_HOSTS];
  return hosts.filter((host, index) => DEFAULT_HOSTS.includes(host) && hosts.indexOf(host) === index);
}

function normalizeManifestPath(bundleId: string, manifestPath?: string): string {
  const normalized = (manifestPath?.trim() || `/.well-known/skill-bundles/${bundleId}/share.json`)
    .replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeSiteUrl(siteUrl?: string): string {
  return (siteUrl?.trim() || process.env.UNBROWSE_SITE_URL?.trim() || DEFAULT_SITE_URL).replace(/\/+$/, "");
}

function resolveRepoPath(repoRoot: string, target: string): string {
  return isAbsolute(target) ? target : resolve(repoRoot, target);
}

function readPresetFromPath(presetPath: string): FoundryPreset {
  return JSON.parse(readFileSync(presetPath, "utf-8")) as FoundryPreset;
}

function loadPreset(input: PublishFoundryBundleInput): { preset: FoundryPreset; presetPath?: string } {
  if (input.preset) return { preset: input.preset };
  if (!input.presetPath) throw new Error("publish-bundle requires preset_path");
  return {
    preset: readPresetFromPath(input.presetPath),
    presetPath: input.presetPath,
  };
}

function installCommandForSkill(skill: string, source?: FoundryPreset["skill_sources"][string]): string | null {
  if (source?.install?.trim()) return source.install.trim();
  const repo = source?.repo?.trim();
  if (!repo || repo === "local") return null;
  return `npx skills add ${repo} --skill ${skill} --yes`;
}

function buildInstallCommands(preset: FoundryPreset): { foundry: string; bundle_skills: string[] } {
  const foundry = preset.fabric?.repo?.trim()
    ? `npx skills add ${preset.fabric.repo.trim()} --skill ${preset.fabric?.skill?.trim() || "foundry"} --yes`
    : DEFAULT_FOUNDARY_INSTALL;

  const bundleSkills = (preset.skills ?? [])
    .map((skill) => installCommandForSkill(skill, preset.skill_sources?.[skill]))
    .filter((command): command is string => !!command);

  return { foundry, bundle_skills: bundleSkills };
}

function buildHostTargets(hosts: FoundryHost[]): Array<{ host: FoundryHost; target_path: string; snippet_path: string }> {
  return hosts.map((host) => ({
    host,
    target_path: HOST_TARGETS[host].target_path,
    snippet_path: HOST_TARGETS[host].snippet_path,
  }));
}

function buildBundleArtifact(
  preset: FoundryPreset,
  hosts: FoundryHost[],
  installCommands: { foundry: string; bundle_skills: string[] },
  manifestPath: string,
) {
  return {
    bundle_id: preset.bundle_id,
    title: preset.title,
    ...(preset.fabric ? { fabric: preset.fabric } : {}),
    ...(preset.repo ? { repo: preset.repo } : {}),
    ...(preset.bootstrap_skill ? { bootstrap_skill: preset.bootstrap_skill } : {}),
    skills: preset.skills ?? [],
    ...(preset.skill_sources ? { skill_sources: preset.skill_sources } : {}),
    ...(preset.dependency_graph ? { dependency_graph: preset.dependency_graph } : {}),
    ...(preset.routes ? { routes: preset.routes } : {}),
    install_commands: installCommands,
    host_targets: buildHostTargets(hosts),
    share: {
      transport: preset.share?.transport ?? "files",
      manifest_path: manifestPath,
    },
    ...(preset.index ? { index: preset.index } : {}),
  };
}

function buildRegistryEntry(preset: FoundryPreset) {
  return {
    slug: preset.index?.slug ?? preset.bundle_id,
    title: preset.title,
    summary: preset.index?.summary ?? "",
    tags: preset.index?.tags ?? [],
    ...(preset.fabric ? { fabric: preset.fabric } : {}),
    ...(preset.repo ? { repo: preset.repo } : {}),
    bundle_id: preset.bundle_id,
    ...(preset.bootstrap_skill ? { bootstrap_skill: preset.bootstrap_skill } : {}),
    skills: preset.skills ?? [],
    ...(preset.skill_sources ? { skill_sources: preset.skill_sources } : {}),
    ...(preset.routes ? { routes: preset.routes } : {}),
    ...(preset.dependency_graph ? { dependency_graph: preset.dependency_graph } : {}),
  };
}

function buildShareArtifact(
  preset: FoundryPreset,
  hosts: FoundryHost[],
  installCommands: { foundry: string; bundle_skills: string[] },
  manifestPath: string,
) {
  return {
    bundle_id: preset.bundle_id,
    ...(preset.fabric ? { fabric: preset.fabric } : {}),
    transport: preset.share?.transport ?? "files",
    manifest_path: manifestPath,
    ...(preset.repo ? { repo: preset.repo } : {}),
    skills: preset.skills ?? [],
    ...(preset.skill_sources ? { skill_sources: preset.skill_sources } : {}),
    ...(preset.dependency_graph ? { dependency_graph: preset.dependency_graph } : {}),
    install_commands: installCommands,
    host_targets: buildHostTargets(hosts),
  };
}

function buildCandidateSkillsArtifact(bundleId: string) {
  return {
    bundle_id: bundleId,
    generated_at: new Date().toISOString(),
    threshold: 3,
    candidates: [],
    install_result: null,
  };
}

function buildActionDagArtifact() {
  return {
    nodes: [],
    edges: [],
    goal_starts: [],
  };
}

function buildNextActionDatasetArtifact() {
  return {
    examples: [],
    count: 0,
  };
}

function buildToolRoutingReportArtifact(bundleId: string) {
  const actionDag = buildActionDagArtifact();
  const nextActionDataset = buildNextActionDatasetArtifact();
  return {
    bundle_id: bundleId,
    session_count: 0,
    node_count: actionDag.nodes.length,
    edge_count: actionDag.edges.length,
    action_dag: actionDag,
    next_action_dataset: nextActionDataset,
  };
}

function renderHostSnippet(
  preset: FoundryPreset,
  host: FoundryHost,
  installCommands: { foundry: string; bundle_skills: string[] },
): string {
  const lines: string[] = [
    "<!-- FOUNDRY_BUNDLE:BEGIN -->",
    `## ${preset.title} (${host})`,
    "",
    "Install Foundry:",
    `- \`${installCommands.foundry}\``,
    "",
    "Install bundled skills:",
  ];

  if (installCommands.bundle_skills.length === 0) {
    lines.push("- no installable remote skills declared in this preset");
  } else {
    for (const command of installCommands.bundle_skills) lines.push(`- \`${command}\``);
  }

  lines.push(
    "",
    "Bundle entrypoint:",
    "- If the request is about mining chat history into skills, discovering candidate skills, fabricating a portable bundle, sharing it, indexing it, or writing host routing memory, call `foundry`.",
    "",
    "Skill-call routing defaults:",
  );

  for (const route of preset.routes ?? []) {
    lines.push(`- If ${route.when}, call \`${route.call}\`.`);
  }

  const bootstrapSkill = preset.bootstrap_skill?.trim();
  if (bootstrapSkill) {
    lines.push(
      "",
      `Use \`${bootstrapSkill}\` first when available to confirm/install the right skill, then call \`foundry\` or the routed skill.`,
    );
  }

  lines.push("<!-- FOUNDRY_BUNDLE:END -->");
  return lines.join("\n");
}

function writeJson(target: string, data: unknown): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return target;
}

function writeText(target: string, content: string): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content + "\n", "utf-8");
  return target;
}

export function publishFoundryBundle(input: PublishFoundryBundleInput): PublishFoundryBundleResult {
  const repoRoot = input.repoRoot ? resolve(input.repoRoot) : process.cwd();
  const { preset: rawPreset, presetPath: rawPresetPath } = loadPreset(input);
  const preset = ensureObject(rawPreset, "Foundry preset must be an object") as FoundryPreset;
  preset.bundle_id = ensureBundleId(preset.bundle_id);
  preset.title = ensureTitle(preset.title, preset.bundle_id);

  const hosts = normalizeHosts(input.hosts);
  if (hosts.length === 0) throw new Error("publish-bundle requires at least one valid host");

  const manifestPath = normalizeManifestPath(preset.bundle_id, preset.share?.manifest_path);
  const siteUrl = normalizeSiteUrl(input.siteUrl);
  const installCommands = buildInstallCommands(preset);
  const bundleDir = join(repoRoot, "skills", ".bundles", preset.bundle_id);

  const bundleArtifact = buildBundleArtifact(preset, hosts, installCommands, manifestPath);
  const registryEntryArtifact = buildRegistryEntry(preset);
  const shareArtifact = buildShareArtifact(preset, hosts, installCommands, manifestPath);
  const candidateSkillsArtifact = buildCandidateSkillsArtifact(preset.bundle_id);
  const actionDagArtifact = buildActionDagArtifact();
  const nextActionDatasetArtifact = buildNextActionDatasetArtifact();
  const toolRoutingReportArtifact = buildToolRoutingReportArtifact(preset.bundle_id);

  const presetPath = rawPresetPath ? resolveRepoPath(repoRoot, rawPresetPath) : undefined;
  const publicManifestPath = join(repoRoot, "frontend", "public", manifestPath.replace(/^\/+/, ""));

  const files = {
    bundle: writeJson(join(bundleDir, "bundle.json"), bundleArtifact),
    registry_entry: writeJson(join(bundleDir, "registry-entry.json"), registryEntryArtifact),
    share: writeJson(join(bundleDir, "share.json"), shareArtifact),
    candidate_skills: writeJson(join(bundleDir, "candidate-skills.json"), candidateSkillsArtifact),
    action_dag: writeJson(join(bundleDir, "action-dag.json"), actionDagArtifact),
    next_action_dataset: writeJson(join(bundleDir, "next-action-dataset.json"), nextActionDatasetArtifact),
    tool_routing_report: writeJson(join(bundleDir, "tool-routing-report.json"), toolRoutingReportArtifact),
    host_snippets: {} as Record<string, string>,
  };

  for (const host of hosts) {
    const target = join(bundleDir, HOST_TARGETS[host].snippet_path);
    files.host_snippets[host] = writeText(target, renderHostSnippet(preset, host, installCommands));
  }

  writeJson(publicManifestPath, shareArtifact);

  return {
    ok: true,
    bundle_id: preset.bundle_id,
    ...(presetPath ? { preset_path: presetPath } : {}),
    bundle_dir: bundleDir,
    public_manifest_path: publicManifestPath,
    public_url: `${siteUrl}${manifestPath}`,
    files,
  };
}

export function publishFoundryBundleFromPresetPath(
  presetPath: string,
  options?: Omit<PublishFoundryBundleInput, "presetPath">,
): PublishFoundryBundleResult {
  return publishFoundryBundle({
    ...options,
    presetPath,
  });
}

export function foundryBundleExists(repoRoot: string, bundleId: string): boolean {
  return existsSync(join(repoRoot, "skills", ".bundles", bundleId, "bundle.json"));
}
