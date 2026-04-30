# go — Open Browser

Opens a Kuri browser tab at the given URL. This is the first step in any capture or exploration session.

## Usage
```
unbrowse go https://example.com
```

## Returns
- Tab ID (used for subsequent commands)
- Page title
- Initial HTML snippet
- Pre-capture screenshot (base64 PNG)

## In Harness
Used as the starting point for both capture and interactive exploration. The harness captures the pre-capture screenshot to understand what the page looks like before JS execution.

## Visual Context
The pre-capture screenshot shows the raw HTML-rendered page. Compare this with the post-capture screenshot to understand what JavaScript changed — missing API endpoints, auth walls, loading spinners, etc.
