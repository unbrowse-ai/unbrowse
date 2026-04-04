<!-- FOUNDRY_BUNDLE:BEGIN -->
## X Account Operator Bundle (claude)

Install Foundry:
- `npx skills add https://github.com/unbrowse-ai/foundry --skill foundry --yes`

Install bundled skills:
- `npx skills add https://github.com/unbrowse-ai/unbrowse --skill x-account-operator --yes`
- `npx skills add https://github.com/unbrowse-ai/unbrowse --skill x-brand-banter --yes`
- `npx skills add https://github.com/unbrowse-ai/unbrowse --skill x-campaign-feedback-operator --yes`
- `npx skills add typefully/agent-skills@typefully -g -y`

Bundle entrypoint:
- If the request is about mining chat history into skills, discovering candidate skills, fabricating a portable bundle, sharing it, indexing it, or writing host routing memory, call `foundry`.

Skill-call routing defaults:
- If the request is about revamping the Typefully queue or deciding what the X account should post next, call `x-account-operator`.
- If the request is about making the X account funnier, sharper, or more like a remembered brand account, call `x-account-operator`.
- If the request is about extracting winners, cutting filler, and rewriting the queue around a stronger account voice, call `x-account-operator`.

Use `find-skills` first when available to confirm/install the right skill, then call `foundry` or the routed skill.
<!-- FOUNDRY_BUNDLE:END -->
