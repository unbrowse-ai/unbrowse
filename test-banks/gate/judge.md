A web research agent was given this task and has answered it. Judge the answer against the task's check.

Task: {task}
Start page: {url}

The check, as written: `{check}`
In words: {check_words}

The agent's final JSON:
```json
{answer}
```

The last tool results the agent saw (cut):
{seen}

Did a tool reply say the page needs clicks or typing? {needed_hands}

Decide two things:
1. meets_check: does the answer (its "answer" text and its "items") meet the check exactly as written? Apply the check
   to the answer as given. Do not reward an answer for being plausible, and do not fail it because you would have
   answered differently: the check is the standard.
2. finished: did the agent finish the task it was given? If the page needed clicks or typing, it is finished only if
   the tool results show the agent did them and read the result. If no clicks were needed, it is finished.

Reply with exactly one JSON object in a ```json code block and nothing after it:
```json
{{"meets_check": true, "finished": true, "why": "one sentence naming what in the answer meets or misses the check"}}
```
