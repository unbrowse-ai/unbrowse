# Nebius port for the search_evals BrowseComp/Exa harness

The vendored `perplexityai/search_evals` harness (gitignored under
`bench/browsecomp/vendor/`) couples **both** the answering agent
(`agents/llms/openai.py`) **and** the graders (`suites/graders.py`) to OpenAI's
**Responses API** (`client.responses.create/parse`). Nebius TokenFactory speaks
only `chat.completions`, so a config repoint of `OPENAI_BASE_URL` fails.

This overlay ports the LLM layer to chat-completions so the harness runs on
Nebius-hosted models (e.g. `moonshotai/Kimi-K2.6`). The three files here mirror
their paths in the vendored tree; `apply.sh` copies them in (idempotent).

| file | change |
|---|---|
| `agents/llms/nebius.py` | NEW `NebiusLLM`/`NebiusConversation` chat-completions backend (mirrors the Anthropic backend; transforms OpenAI tool schemas → chat-completions function-tools; generous `max_tokens` for Kimi's reasoning budget). |
| `agents/llms/__init__.py` | `make_llm` routes `nebius/<model>` → `NebiusLLM`. |
| `suites/graders.py` | `DeepResearchGrader` gains a `GRADER_BACKEND=nebius` path that judges via Kimi chat-completions, **keeping the exact BrowseComp grader prompt + CORRECT/INCORRECT rubric** — only the judge model + wire protocol change. |

## ⚠ Methodology honesty (do not skip)

A Nebius/Kimi run is a **real, reproducible** number, but it is **NOT Exa's
published methodology**. Exa's BrowseComp 0.336 used their answering agent + a
gpt-4.1 grader over the Responses API. This pipeline is:

> **unbrowse `search()` retrieval + Kimi-K2.6 answering agent + Kimi-K2.6 grader.**

So the number measures *how good unbrowse's search is as an agent tool for a Kimi
deep-research loop* — a genuine signal — but it must be labelled exactly that,
never reported as "beat Exa 0.336" apples-to-apples. The clean comparison still
requires a funded OpenAI key (Responses API + gpt-4.1 grader).

## Run

See `apply.sh` (prints the run command after applying).
