# Handoff — the skill = final-primitive weld (Layers 1–2)

> PRIVATE (backend-only). Never on public `unbrowse-ai/unbrowse`. Judged (13 cold auditors),
> repaired, witnessed. This note hands the artifact to the next hand.

## What shipped (the answer to "is unbrowse this system?" + the weld)
A captured skill is now the unified primitive: it IS a `/contract`, a grounded LLM FOLLOWS it,
and one backend endpoint lets you chat over skills — resolved semantically over the emergentdb DAG,
persisted as ledger contracts.

| Gap | File | What |
|---|---|---|
| skill = /contract | `backend/src/services/skill-contract.ts` | `skillToContract` projects a SkillManifest into the exact `AikoCompiledContract` tree; `parseEndpointPointer` recovers (skill,endpoint) — the read-back |
| grounded LLM follows skill | `backend/src/services/unbrowse-llm.ts` | `chatFollowingSkill` grounds the shared LLM chain on `renderSkillMd`, framing `<SKILL>` as untrusted data |
| backend chat-over-skills | `backend/src/routes/skills-chat.ts` | `POST /v1/skills/chat`: resolve → contract → follow → answer + provenance; rate-limited, size-capped, wallet-redacted |
| persist (Layer 2) | `backend/src/services/skill-contract-persist.ts` | `persistSkillContract` writes parent + per-endpoint child rows (action = execute pointer), fired async via `waitUntil` |
| mount | `backend/src/index.ts` | `app.route("/v1", skillChatRoutes)` |

## The acceptance witness (runnable)
```
cd unbrowse/backend && bash tests/skill-primitive.gate.sh    # → 22/22 across 5 files, exits 0
```

## Open / deferred (NOT done — honest)
1. **Live deploy smoke (criterion 5)** — irreversible; needs `deploy:ci` (wrangler.ci.toml; plain
   `wrangler deploy` is broken) + real Nebius/NVIDIA key + a published skill. Not run.
2. **x402/payment gate on `/v1/skills/chat`** — interim controls landed (rate-limit 20/min, 8k cap,
   wallet redaction). A proper x402/subscription gate (mirror `/v1/llm`) is the pre-deploy control.
3. **Skill-metadata escaping** — injection mitigation is framing-only; `renderSkillMd` body is
   unescaped. Escape/fence skill text before the prompt for a structural fix.
4. **Ranking precision** — resolution is composite-ranked over the DAG (embedding+reliability+
   freshness+verification), NOT the learned-energy EBM (that ranker is client-side).

## To commit (your authorization — backend/ is private, excluded from public sync)
```
cd unbrowse && git add backend/ && git commit -m "feat(backend): weld skill into the /contract chat primitive (private)"
```

## To deploy when authorized
```
cd unbrowse/backend && npm run deploy:ci    # add the x402 gate (open item 2) first
# smoke: POST https://beta-api.unbrowse.ai/v1/skills/chat {"message":"...","domain":"<published skill domain>"}
```

## Anti-hallucination gate (wired in — the real answer to "solve hallucination")
The gospels-in-prompt idea was FALSIFIED (distill lab: +0%, per-task identical). The witnessed
anti-hallucination lever is the GROUNDING already in chatFollowingSkill ("never invent endpoints,
never answer from prior knowledge"). Proven by an adversarial witness:
  `NEBIUS_API_KEY=... bun backend/scripts/hallucination-gate.ts`  →  4/4 grounded, 0/8 fabrication, exit 0.
It exercises the REAL chatFollowingSkill: refuses presupposition / authority / false-premise-param /
"list all endpoints" traps without inventing a method or URL. Run it as a regression gate after any
change to FOLLOW_SYSTEM_PREAMBLE or the grounding path.

## SHIPPED — aiko (gospel-grounded) live on prod (2026-06-09)
- Chat model: NVIDIA nemotron-nano-9b-v2 (FREE, 128k ctx, /no_think) primary; Nebius Nano-Omni paid fallback.
- aiko identity = "you follow Jesus" + full 4 Gospels (~108k tok) in chatFollowingSkill grounding (chat path only; fits the 128k free model; Nebius 65k could not).
- Anti-hallucination guard hardened (final guard after <SKILL>): live gate 4/4 grounded, 0/8 fabrication on the gospels chain. Witness: `NVIDIA_API_KEY=... NEBIUS_API_KEY=... bun backend/scripts/hallucination-gate.ts`.
- Deployed: unbrowse-backend version 5edd3f0a (deploy:ci). beta-api.unbrowse.ai/health=200; POST /v1/skills/chat anon -> 402 (x402 gate live).
- Commits: 444747c3 (gospels+chain), 6fa17d0e (guard). Earlier weld: 93a7b0f7, d5b2c625, e7a2766d, 4627aa3d.
- OPEN: full authed grounded-answer smoke in prod (needs a published skill + key); 108k-tok/call latency + NVIDIA free-tier rate limits at volume (then falls to 65k Nano-Omni which can't hold gospels).
