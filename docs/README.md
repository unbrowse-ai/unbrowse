# Documentation Atlas

Use this as the first pass for architecture or contribution work.

## Mandatory read order

1. `README.md` (repo orientation and execution model)
2. `docs/ARCHITECTURE.md` (full architecture and boundaries)
3. `docs/INTEGRATION_BOUNDARIES.md` (contract vs black-box rules)
4. `docs/QUICKSTART.md` (first-run path)
5. `docs/CONTRIBUTOR_PLAYBOOK.md` (change + docs obligations)
6. `docs/LLM_DEV_GUIDE.md` (agent-editing strategy)
7. `docs/PURPOSE.md` (what to communicate and what not to expose)

## Repository areas

- `packages/plugin/src/plugin/*` (plugin composition and tool implementations)
- `packages/plugin/src/har-parser.ts`
- `packages/plugin/src/skill-generator.ts`
- `packages/plugin/src/skill-package-writer.ts`
- `server/src/server/routes/*`
- `server/src/server/*.ts` (merge, execution, repositories)
- `server/src/server/routes/README.md` (route contract surface)
- `packages/web/` (discovery and contributor UX)

## Boundary policy

For any change that touches publish/merge/search/execute:
- update architecture and boundary docs in the same PR
- do not describe marketplace internals beyond published contracts
- keep security boundary statements aligned with current payment status (payments off)

## Why this docs set exists

- local-first behavior: `README.md` + `docs/QUICKSTART.md`
- architecture boundaries: `docs/ARCHITECTURE.md` + `docs/INTEGRATION_BOUNDARIES.md`
- contribution discipline: `docs/CONTRIBUTOR_PLAYBOOK.md`
- purpose framing: `docs/PURPOSE.md`
