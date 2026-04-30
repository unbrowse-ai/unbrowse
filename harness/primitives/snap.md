# snap — A11y Snapshot

Captures an accessibility tree snapshot of the current page, optionally filtered for interactive elements.

## Usage
```
# Full a11y snapshot
unbrowse snap --session <id>

# Interactive elements only (buttons, links, inputs)
unbrowse snap --filter interactive --session <id>

# Specific role
unbrowse snap --filter button --session <id>
```

## Returns
- Structured accessibility tree
- Interactive element references (used by click/fill/press commands)
- Post-capture screenshot (base64 PNG)

## In Harness
The snap command is the primary way to discover interactive elements that lead to API calls. Use `--filter interactive` to get buttons, links, and inputs that trigger network requests. Compare the snapshot with the captured network requests to verify all API endpoints were triggered.

## Visual Context
The post-snap screenshot shows what the page looks like after interaction. If the API call triggered a visual change (e.g., timeline items appearing), this screenshot confirms it.
