A web research agent was given this task and has answered it. Judge the answer against the task's check.

Task: {task}
Start page: {url}

The check, as written: `{check}`
In words: {check_words}

The agent's final JSON:
```json
{answer}
```

The tool results the agent saw, in order (numbered and cut when long):
{seen}

Did a tool reply say the page needs clicks or typing? {needed_hands}

Decide two things:
1. meets_check: does the answer (its "answer" text and its "items") meet the check exactly as written? Apply the check
   to the answer as given. Do not reward an answer for being plausible, and do not fail it because you would have
   answered differently: the check is the standard. `{{session}}` is the node's mark for a value it hid: where the answer
   says `{{session}}` in place of the site's own value (a link, a name, a field), that value is missing.
2. finished: did the agent finish the task it was given? Judge the path that supplied the answer. If that path needed
   clicks or typing, the tool results must show the agent did them and read the result. If a different path asked for
   interaction and did not answer, that alone does not make the path that returned the data unfinished.
   A successful direct read of an allowed source can finish the task when the tool results show the evidence there.
   A successful browser interaction may return only `✓ Done`. Read that reply together with the next tool results.
   If they show the new page content or controls the interaction opened and the agent read the requested data from
   there, that sequence can show completion. `✓ Done` by itself does not establish what changed.

Reply with exactly one JSON object in a ```json code block and nothing after it:
```json
{{"meets_check": true, "finished": true, "why": "one sentence naming what in the answer meets or misses the check"}}
```
