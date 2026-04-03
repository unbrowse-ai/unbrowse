<!-- FOUNDRY_BUNDLE:BEGIN -->
## X Campaign Feedback Operator Bundle (openclaw)

Install Foundry:
- `npx skills add https://github.com/unbrowse-ai/foundry --skill foundry --yes`

Install bundled skills:
- `npx skills add https://github.com/unbrowse-ai/unbrowse --skill x-campaign-feedback-operator --yes`

Bundle entrypoint:
- If the request is about mining chat history into skills, discovering candidate skills, fabricating a portable bundle, sharing it, indexing it, or writing host routing memory, call `foundry`.

Skill-call routing defaults:
- If the request is about which X post, article, ad, campaign, or landing variant is actually winning, call `x-campaign-feedback-operator`.
- If the request is about joining X-native metrics to installs or first success, call `x-campaign-feedback-operator`.
- If the request is about aligning X campaigns, articles, ads, and landing variants under one id scheme, call `x-campaign-feedback-operator`.

Use `find-skills` first when available to confirm/install the right skill, then call `foundry` or the routed skill.
<!-- FOUNDRY_BUNDLE:END -->
