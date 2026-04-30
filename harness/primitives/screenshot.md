# screenshot — Capture Browser Screenshot

Takes a screenshot of the current browser tab and returns it as a base64 PNG.

## Usage
```
# Latest session
unbrowse screenshot --session <id>

# Full page
unbrowse screenshot --session <id> --full-page
```

## Returns
- Base64-encoded PNG screenshot

## In Harness
Screenshots are the primary visual context for the harness. They're captured at 3 key points:
1. **Pre-capture** — after navigation, before JS fully loads
2. **Post-capture** — after full page load and adaptive wait
3. **Post-resolve** — after resolve completes, showing what the page looks like at that moment

Use screenshots to:
- Detect auth walls (login forms, CAPTCHAs)
- Identify JavaScript rendering issues (spinners, empty states)
- Verify that interaction triggers API calls (elements appearing/disappearing)
- Understand what the agent-USER actually sees vs what the agent-REVERSE ENGINEER sees

## Visual Context
Screenshots bridge the empathy gap between the automated capture pipeline and the actual human experience of the page. A page that looks "fine" in the network log might show a broken layout, infinite spinner, or auth wall to the user.
