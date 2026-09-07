# unbrowse-browser-use — a drop-in for `browser-use`

Same `Agent` surface as [`browser-use`](https://github.com/browser-use/browser-use),
one import swap:

```python
# from browser_use import Agent
from unbrowse_browser_use import Agent

agent = Agent(task="get the top story on hacker news", llm=my_llm)
history = await agent.run()
print(history.final_result())
```

Provides `Agent(task, llm=...)`, `await agent.run()` (plus `run_sync()`), an
`AgentHistoryList` with `.final_result()/.is_done()/.urls()/.extracted_content()/
.errors()`, and `Browser`, `BrowserConfig`, `Controller` — the surface your agent
code already calls. Instead of driving a live browser step-by-step with an LLM call
per step, it resolves the task against the Unbrowse shared route graph and replays
the cached API route when one exists (live capture only on a miss).

Offline shape mode for tests/CI: set `UNBROWSE_BROWSER_USE_DRYRUN=1`.

This is a **drop-in replacement**. It is not affiliated with or endorsed by the
browser-use project; `browser-use` is the upstream this package is a drop-in for,
and trademarks belong to their respective owners.

## Test

```sh
python3 packages/py-browser-use/tests/test_shape.py
```
