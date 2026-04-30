# feedback — Rate Endpoint Quality

Submits feedback about an endpoint's quality. This feeds into the scoring system used by the ranker.

## Usage
```
# Rate a specific endpoint
unbrowse feedback <endpoint_id> --score 5 --reason "Perfect match"

# Rate negatively (triggers staleness signal)
unbrowse feedback <endpoint_id> --score 1 --reason "Wrong endpoint, returns auth wall"
```

## Returns
- Confirmation with updated endpoint score
- Timestamp of feedback

## In Harness
Feedback is how the harness teaches the ranker. When a diagnosis identifies a wrong endpoint match, use feedback to:
- Penalize the wrong endpoint
- Boost the correct one (if discovered)
- Generate the staleness signal that drives A2+E1 fixes

## Visual Context
Feedback should always be accompanied by visual evidence (screenshots). A score of "1" means nothing without the screenshot showing what actually went wrong.
