# resolve — Find APIs for an Intent

Searches cached skills, the marketplace, and (if needed) does live capture to find APIs matching a given intent.

## Usage
```
# Basic resolve
unbrowse resolve "list my tweets" --domain x.com

# With intent refinement
unbrowse resolve "load my timeline" --domain twitter.com

# Force live capture (skip cache)
unbrowse resolve "load timeline" --domain x.com --force-capture
```

## Returns
- Available endpoints with scores, descriptions, and schemas
- Diagnostic context: confidence, reasoning, known issues
- Suggested next actions if no endpoints found

## In Harness
The resolve command is the most commonly failing step in the unbrowse pipeline (41.1% of agents give up here). The harness uses it to:
- Test if a fix improves endpoint matching
- Compare diagnostic confidence scores before/after changes
- Verify that the right endpoints are being found (not wrong ones)

## Visual Context
The resolve response now includes a `diagnostic` field with confidence scores and reasoning. Use this to track whether fixes are actually improving agent confidence, not just endpoint counts.
