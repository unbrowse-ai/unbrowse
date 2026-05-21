## Context gathering (inherited, non-negotiable)

When this harness or its agent must GATHER CONTEXT to plan, justify, or
verify a wave (prior art, an API contract, a spec, a paper, how a tool or
repo actually behaves): it pulls from a real external source and cites it.
The sanctioned sources are the arxiv skill (papers, formal results) and
the deepwiki MCP (how a real repository actually behaves). A fetched page
or repo answer is a source; the model's own memory is not a source.

Every context-derived claim that feeds a criterion, a plan decision, or a
verdict carries its source_id (arxiv id, deepwiki repo, or fetched url) in
references/criteria.md or the ledger row, so a later wave can re-pull and
check it. If no external source is reachable, the harness says so plainly
and the claim stays tagged unverified. It never substitutes a remembered
guess presented as fact.

Same diagnostic as the substrate principle, aimed at inputs: "where did
this context actually come from, and is it true?", never "what do I recall
that would justify the outcome I want?". It prescribes no fixed sequence
of calls; it requires only that context be sourced and cited, and the
agent judges sufficiency in-thread.
