# Short companion tweet (Article link only)

The tweet body is ONLY the X Article link, no commentary. Long-form
references/long-form-article.md: "The tweet body is ONLY the article link.
No commentary. No thread. No 'I wrote this'."

The Article card (title + first paragraph preview) is the entire scroll
stopper. Spend the effort on the title and the first 100 words of the
article, not on the tweet copy.

## Tweet body

<ARTICLE_URL>

## Title that the card surfaces (already in article.md L1)

How we built unbrowse v7.0.0's release gate from 76 Reddit threads

## Action-surface engineering (why this title)

- dwell + dwell_time: "release gate from 76 Reddit threads" is a
  concrete number plus a methodology promise. Reader pauses to parse it
  before scrolling on.
- bookmark: "release gate" plus "Reddit threads" frames the post as a
  reusable methodology guide, not a hot take. Bookmark probability is
  the dominant lever for an X Article.
- profile_click: first-person plural ("we built") on a contestable
  engineering claim invites readers to check who is making it.
- reply: "from Reddit threads" is opinionated enough to draw engineers
  who think corpora should come from somewhere else (random crawl,
  internal traffic, expert judgement). Replies are positive in the
  19-action sum.
- follow_author: the post implies a recurring frame ("we shipped the
  gate that produced it") so a reader who saves this expects more
  releases shipped the same way.

No like-bait. No "RT to win". No em dash. One claim per post (the
article carries the rest).

## Reply plan for the first hour

The first hour is when the 127-history slot collection happens. Replies
ready to fire if these surface:

- "Why Reddit specifically": cite the wave-1 vs wave-2 falsification
  (wave-2 reranked x402_monetization from last to second-strongest).
  Reddit had specificity the other surfaces did not.
- "How is this different from web-bench / WebArena / etc": those are
  research corpora over chosen sites. Our corpus is real user
  complaints typed into probes; the lane taxonomy (public, anchor,
  hostile, auth-gated) is shipped with it.
- "What about the LLM gateway pricing": 50% above raw provider cost
  buys you a unified x402 wallet for routes + LLM in one key. The
  $1-on-signup subsidy lives on the route side; the gateway margin funds it.
- "Show me the corpus": link to `harness/probes/corpus-gate.txt` in
  the repo.

Do not engage outrage-bait or out-group reframing in the first hour.
The negative-four (not_interested, block, mute, report) carry the
sharpest cost and the embedding cluster suppression for that user is
permanent.
