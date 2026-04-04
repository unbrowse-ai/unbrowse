# Workflow Harness

Read when: debugging internal whole-site workflow learning, token lineage, or warm-path mutation replay.

This repo now keeps an internal workflow artifact beside the existing skill manifest/cache layer.
It also writes a sanitized workflow export so mined routes can be published, reviewed, and reused without leaking captured token values.

The split:
- `SkillManifest`: reusable endpoint graph and semantic routing surface
- `WorkflowArtifact`: local execution memory for hostile sites and mutations
- `WorkflowPublishArtifact`: censored publish/export view of the workflow memory

The workflow artifact stores:
- site/auth fingerprint
- observed request evidence
- trigger URLs
- JS bundle hints
- DOM token hints from hidden inputs, meta tags, and inline bootstrap JSON
- per-endpoint recipes with ordered fallback steps
- token bindings for header/body injection
- mutation guards and last successful strategy

Current behavior:
- live capture writes a workflow artifact for the learned skill
- live capture also writes a sanitized workflow export for the same `skill_id`
- explicit checkpoint commands (`sync`, `close`) queue the background `index -> publish` pipeline
- local settings can disable auto-publish entirely or guard specific domains with blacklist/prompt-list rules
- local `index` upgrades the export from `captured` to `indexed`
- explicit/queued remote share upgrades the export from `indexed` to `published` (or `blocked-validation`)
- execution loads the artifact by `skill_id`
- if a recipe exists for the endpoint, execution tries the saved recipe first
- token bindings are resolved from the freshest cookies/headers before replay
- token/auth failure statuses (`401`, `403`, `419`, `422`) trigger one browser auth refresh and one retry through the same recipe
- successful steps are promoted to the front of the recipe for warm runs

Local storage:
- skill snapshots: `~/.unbrowse/skill-snapshots/`
- workflow artifacts: `~/.unbrowse/workflow-artifacts/`
- workflow exports: `~/.unbrowse/workflow-exports/`

The export stores:
- sanitized endpoints ready for publish review
- trigger/provenance strategy order per endpoint
- token-binding maps without captured token values
- mutation guard state
- lightweight doc bullets for human review
- publish status (`captured`, `indexed`, `blocked-validation`, `published`)

Artifact shape lives in [`src/types/skill.ts`](/Users/lekt9/.codex/worktrees/5f9a/unbrowse/src/types/skill.ts).
Compile helpers live in [`src/workflow/compile.ts`](/Users/lekt9/.codex/worktrees/5f9a/unbrowse/src/workflow/compile.ts).
Runtime helpers live in [`src/workflow/runtime.ts`](/Users/lekt9/.codex/worktrees/5f9a/unbrowse/src/workflow/runtime.ts).
Publish/export helpers live in [`src/workflow/publish.ts`](/Users/lekt9/.codex/worktrees/5f9a/unbrowse/src/workflow/publish.ts).
