# publish — Publish/Reindex Skills

Publishes locally cached/reviewed skills to the marketplace. Combines index and publish in one step.

## Usage
```
# Publish all cached skills
unbrowse publish

# Publish a specific skill
unbrowse publish <skill_id>
```

## Returns
- Published skill count
- Marketplace sync status
- Any errors during publication

## In Harness
After diagnosis + repair + verify phases, publish to push fixes to the shared marketplace. This is the final step of the self-improvement loop — what the dev discovers for themselves should help everyone.
