# X Account Operator Router

Keep the entry skill on the operating loop. Route subwork out fast.

## Read order

1. current winners
2. current queue
3. draft bank
4. account voice choice
5. keep / cut / rewrite decision

## Route to other skills

- use [x-campaign-feedback-operator](/Users/lekt9/.codex/worktrees/a7c7/unbrowse/skills/x-campaign-feedback-operator/SKILL.md) for performance diagnosis and winner extraction
- use [x-brand-banter](/Users/lekt9/.codex/worktrees/a7c7/unbrowse/skills/x-brand-banter/SKILL.md) for in-character post/reply writing
- use [`typefully`](/Users/lekt9/.agents/skills/typefully/SKILL.md) for draft updates, deletions, scheduling, and queue reads
- use [`x-virality`](/Users/lekt9/.hermes/skills/social-media/x-virality/SKILL.md) when the question becomes reach mechanics instead of account taste

## Decision rules

- if the ask is `revamp the queue` -> use `x-account-operator`
- if the ask is `make the account funnier / more alive` -> start here, then route voice work to `x-brand-banter`
- if the ask is `which posts won` -> route measurement to `x-campaign-feedback-operator`
- if the ask is `write one reply` -> do not use this skill; use `x-brand-banter`
- if the ask is `schedule this draft` -> do not use this skill; use `typefully`

## Failure modes

- account becomes a deck, not a character
- too many benchmark receipts; no worldview
- too much worldview; no receipt
- every post sounds like the same thesis with nouns swapped
- queue density hides weak taste instead of improving it
