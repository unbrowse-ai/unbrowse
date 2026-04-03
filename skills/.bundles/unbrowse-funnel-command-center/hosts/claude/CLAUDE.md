<!-- FOUNDRY_BUNDLE:BEGIN -->
## Unbrowse Funnel Command Center Bundle (claude)

Install Foundry:
- `npx skills add https://github.com/unbrowse-ai/foundry --skill foundry --yes`

Install bundled skills:
- `npx skills add https://github.com/unbrowse-ai/unbrowse --skill unbrowse-funnel-command-center --yes`
- `npx skills add https://github.com/unbrowse-ai/unbrowse --skill internal-analytics --yes`
- `npx skills add https://github.com/unbrowse-ai/unbrowse --skill unbrowse-acquisition-operator --yes`
- `npx skills add https://github.com/unbrowse-ai/unbrowse --skill x-campaign-feedback-operator --yes`

Bundle entrypoint:
- If the request is about mining chat history into skills, discovering candidate skills, fabricating a portable bundle, sharing it, indexing it, or writing host routing memory, call `foundry`.

Skill-call routing defaults:
- If the request is about the entire funnel, biggest leak, or what to tighten next, call `unbrowse-funnel-command-center`.
- If the request is about private analytics truth or route contracts, call `internal-analytics`.
- If the request is about traffic, ICPs, variants, or landing leakage, call `unbrowse-acquisition-operator`.
- If the request is about X posts, articles, ads, and landing variants aligning under one feedback loop, call `x-campaign-feedback-operator`.

Use `find-skills` first when available to confirm/install the right skill, then call `foundry` or the routed skill.
<!-- FOUNDRY_BUNDLE:END -->
