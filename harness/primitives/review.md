# review — Push Reviewed Descriptions

Pushes improved endpoint descriptions and schemas back to a skill's manifest. Used when the agent discovers better descriptions than the auto-generated ones.

## Usage
```
# Push reviewed descriptions
unbrowse review <skill_id> --endpoint <endpoint_id> --desc "Load the user's tweet timeline"

# Review with schema update
unbrowse review <skill_id> --schema '{"type": "object", "properties": {"tweets": {"type": "array"}}}'
```

## Returns
- Updated skill manifest
- Confirmation of merged changes

## In Harness
When the harness discovers that auto-generated descriptions are too generic (C1 issue), use review to push better, intent-specific descriptions. This improves BM25 matching for future resolves.

## Visual Context
Review should include the screenshot evidence showing why the new description is more accurate — e.g., the endpoint actually returns tweet data, not user profiles.
