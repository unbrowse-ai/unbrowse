// Maps a publishSkill() thrown Error message to its HTTP response. Extracted as a
// pure function so the publish route's failure path is testable in isolation — and so
// distinct publish refusals each surface their OWN reason instead of collapsing into a
// generic 500 (the masked error that cost real `wrangler tail` debugging: a
// `publish_forbidden_not_owner` was returning 500 "Failed to publish skill" with no
// hint of the actual ownership refusal). Fail honestly: every known refusal names
// itself; only a genuinely unexpected error falls through to 500.

export interface PublishErrorResponse {
  status: 403 | 400 | 500;
  body: Record<string, unknown>;
}

export function mapPublishError(msg: string): PublishErrorResponse {
  if (msg.startsWith("publish_forbidden_reserved_domain:")) {
    const reserved = msg.slice("publish_forbidden_reserved_domain:".length);
    return {
      status: 403,
      body: {
        error: "publish_forbidden_reserved_domain",
        message: `"${reserved}" is on the reserved-domain list and may only be published by admin keys.`,
        reserved_domain: reserved,
      },
    };
  }
  if (msg.startsWith("publish_forbidden_domain_unverified:")) {
    const domain = msg.slice("publish_forbidden_domain_unverified:".length);
    return {
      status: 403,
      body: {
        error: "publish_forbidden_domain_unverified",
        message: `Domain control for "${domain}" has not been verified. POST /v1/skills/by-domain/${domain}/verify/challenge to start the .well-known probe flow.`,
        domain,
        next_step: `/v1/skills/by-domain/${domain}/verify/challenge`,
      },
    };
  }
  // The masked-500 fix: a DNS-verified domain's owner has exclusivity, so a non-owner
  // publish is refused — surface it as a 403 with the reason, not a generic 500.
  if (msg === "publish_forbidden_not_owner") {
    return {
      status: 403,
      body: {
        error: "publish_forbidden_not_owner",
        message:
          "This domain is DNS-verified and owned by another agent; only its verified owner (or an admin) may publish to it. Unverified domains are communal — verify control via the .well-known probe to claim exclusivity.",
      },
    };
  }
  if (msg.startsWith("publish_forbidden_taken_down:")) {
    const domain = msg.slice("publish_forbidden_taken_down:".length);
    return {
      status: 403,
      body: {
        error: "publish_forbidden_taken_down",
        message: `Publishing for "${domain}" is disabled: its verified owner has filed a takedown. No further publishes are accepted for this domain.`,
        domain,
      },
    };
  }
  if (msg.startsWith("release_manifest_")) {
    return { status: 400, body: { error: msg } };
  }
  return { status: 500, body: { error: "Failed to publish skill" } };
}
