/**
 * stateless — the one check for "is the unbrowse binary running stateless?"
 *
 * A stateless binary holds NO local persisted state: the backend KV holds the
 * cache / sessions / traces, the wallet holds the identity + secrets, and the
 * client only fills holes (auth + LLM) and pipes. In stateless mode the
 * SUPPRESSIBLE local-disk writes (skill caches, route snapshots, execution
 * traces) are skipped — the backend surfaces (/v1/trace/append, /v1/session/park,
 * the sealed content-addressed cache) are the source of truth, host-independent
 * so the same identity resolves the same state on any machine. Reverse-
 * engineering the client yields nothing because the client keeps nothing.
 *
 * One helper so every gate reads the flag the same way. `UNBROWSE_STATELESS=1`
 * (or `true`) turns it on.
 */
export function isStateless(): boolean {
	const v = process.env.UNBROWSE_STATELESS;
	return v === "1" || v === "true";
}
