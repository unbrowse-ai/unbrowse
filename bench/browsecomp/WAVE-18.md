# WAVE-18 — gpt-4.1 unblocked: the real bottleneck is SEARCH on hard queries (2026-05-31)

User funded the frontier path (OpenRouter `openai/gpt-4.1`). Wired it through the
nebius chat-completions backend (OpenRouter speaks chat.completions, not Responses),
fixed the `reasoning.effort` 400, ran apples-to-apples (gpt-4.1 agent + gpt-4.1
grader). Every number read from an exited-0 run.

## Real numbers
| pipeline | N | accuracy |
|---|---|---|
| Kimi-K2.6 + unbrowse(DDG) | 10 | 0.10 |
| Qwen3-235B-Thinking + unbrowse(DDG) | 10 | 0.0 |
| **gpt-4.1 + gpt-4.1 grader + unbrowse(DDG)** | 10 | **0.0** |

Target Exa 0.336. NOT beaten.

## Why gpt-4.1 scored 0 (from the real trace — NOT a harness bug)
gpt-4.1 made **6 real searches/question** then honestly answered: *"no direct
answer found in the search snippets, many results are from crossword or design
template sites… Cloudflare 5xx."* It **correctly refused to hallucinate**. The
failure is the SEARCH, not the agent.

## The bottleneck, proven (DDG vs Google vs Bing via unbrowse, same hard query)
- **DDG** (current `search()` backend): returns junk — echoes the query back as
  wordplays.com crossword / pikwizard template / linkedin-jobs URLs. Cannot find
  obscure multi-hop entities. Enrichment (full page) doesn't help — enriching junk
  is junk.
- **Google / Bing** static `fetch`: return only nav chrome (JS-rendered/bot-walled);
  no result links in the static HTML.

## The real lever (the genuine "solve via unbrowse" path)
unbrowse's actual strength is its **browse engine** (Chrome render + extract +
anti-bot), not a static DDG fetch. The honest next build is a **browse-based
searcher**: `unbrowse go google.com/search?q=… → snap/extract ranked results`,
returning real Google results for hard queries. Slow (Chrome per query) + may hit
captchas, but it is the true unbrowse search surface. DDG-static is a weak SERP and
is the cap at ~0.

## Honest standing conclusion
BrowseComp is search-bound here: a frontier agent (gpt-4.1) is *not* enough when
the retrieval (DDG) can't surface obscure entities — gpt-4.1 honestly returns 0.
To beat 0.336, unbrowse must retrieve like a real engine: browse-render Google
(this build), or a neural search API (defeats "via unbrowse"). The agent + grader
are now correct and frontier-grade; the open node is the SEARCH backend.
