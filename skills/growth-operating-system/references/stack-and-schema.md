# Stack And Schema

## Stack Boundaries

### PostHog
Use for:
- anonymous + known web events
- UTM/referrer attribution
- funnel steps
- cohorting
- activation and retention analysis
- experiment reads

Do not use as CRM.

### Attio
Use for:
- people
- companies
- pipeline stages
- partner / enterprise / investor relationships
- high-intent account views

Do not use as the primary event stream.

### Loops
Use for:
- lifecycle email
- whitepaper follow-up
- launch sequences
- onboarding nudges
- segment-based outbound

Do not use as the system of record.

### Unbrowse Leads Worker
Use for:
- `/v1/leads`
- `/v1/feedback`
- `/v1/experiments` later if needed
- canonical normalization layer
- fan-out to PostHog / Attio / Loops
- event dedupe and identity stitching

## Canonical Objects

### Lead
```json
{
  "lead_id": "uuid",
  "email": "user@company.com",
  "agent_id": "optional-unbrowse-agent-id",
  "github_login": "optional",
  "name": "optional",
  "company": "optional",
  "role": "optional",
  "segment": "builder|framework|enterprise|partner|investor|other",
  "source": "api_key|whitepaper|demo|chat|github_star|discord|manual",
  "campaign": "optional",
  "utm_source": "optional",
  "utm_medium": "optional",
  "utm_campaign": "optional",
  "referrer": "optional",
  "use_case": "optional",
  "consent_email": true,
  "consent_updates": true,
  "created_at": "iso8601",
  "updated_at": "iso8601"
}
```

### Feedback Event
```json
{
  "event_id": "uuid",
  "subject_type": "lead|agent|user|company|issue|campaign",
  "subject_id": "id",
  "kind": "bug|request|praise|blocker|objection|interview|activation-drop|conversion-drop",
  "source": "posthog|discord|github|manual|chat|support",
  "summary": "short normalized statement",
  "raw_reference": "url or internal id",
  "frequency": 1,
  "severity": "p0|p1|p2|p3",
  "confidence": 0.0,
  "suggested_issue_type": "bug|feat|docs|launch|research",
  "created_at": "iso8601"
}
```

### Experiment
```json
{
  "experiment_id": "uuid",
  "name": "short label",
  "loop": "acquisition|activation|retention|monetization|trust",
  "hypothesis": "statement",
  "north_star": "metric name",
  "guardrail_metrics": ["metric"],
  "leading_indicator": "metric",
  "issue_number": 0,
  "status": "planned|running|won|lost|inconclusive",
  "start_date": "yyyy-mm-dd",
  "target_date": "yyyy-mm-dd"
}
```

## Identity Rules

- Prefer `agent_id` when the user has registered.
- Prefer `email` for CRM identity.
- Use GitHub stars as soft identity only; never assume contactability.
- Deduplicate on `email`, then `agent_id`, then explicit linked aliases.

## Ingestion Map

- API key form -> leads worker -> PostHog + Attio + Loops
- whitepaper gate -> leads worker -> PostHog + Attio + Loops
- demo CTA -> leads worker -> PostHog + Attio + Attio pipeline stage
- GitHub star webhook / backfill -> worker -> PostHog event + optional Attio enrichment
- Discord/support/manual notes -> feedback normalization -> GitHub issue candidates
