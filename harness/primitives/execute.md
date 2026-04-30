# execute — Run an API Endpoint

Executes a specific endpoint from a discovered skill.

## Usage
```
# Execute a specific endpoint
unbrowse execute <skill_id> --endpoint <endpoint_id> --params '{"key": "value"}'

# Auto-select best endpoint (no --endpoint)
unbrowse execute <skill_id> --params '{"key": "value"}'
```

## Returns
- Response data
- Execution trace
- Error context with screenshot if failure (Harness #2)
- Recovery suggestions on error (Harness #2)

## In Harness
Execute is the second most common failure point. The harness uses it to:
- Verify that found endpoints actually work
- Test error recovery paths
- Collect feedback on endpoint quality

## Visual Context
When execution fails, the harness injects an error screenshot showing what the page looked like at the time of failure. This helps diagnose whether the failure was due to:
- Auth issues (login screen)
- Rate limiting (CAPTCHA)
- Wrong params (empty state)
- Network error (connection refused)
