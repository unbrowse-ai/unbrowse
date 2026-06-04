/**
 * scheduler — fire the trust-refresh job on the paper's 6h cadence
 * (arXiv:2604.00694 §6.3 "background verification every 6h").
 *
 * `refresh-job.ts` is one pass; this is the standing loop around it. The timer,
 * the route source, and the clock are all INJECTED, so the loop is hermetically
 * testable with no real time and no network — `tick()` is the unit, `start/stop`
 * is the lifecycle. An in-flight pass blocks the next (a 6h re-index sweep must
 * never overlap itself).
 *
 * OPT-IN by law: a live background loop that makes network calls and publishes
 * signed proofs is an operator decision, not a default. `maybeStartTrustRefresh`
 * mounts it only when UNBROWSE_TRUST_REFRESH=1 — mirrors the codebase's existing
 * env-gated surfaces (UNBROWSE_SKIP_PAYMENT, UNBROWSE_FREE_TIER).
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the route code inherits the root signature — pointer not payload; verify via (internal))
import {
	runTrustRefresh,
	TRUST_REFRESH_INTERVAL_MS,
	type RefreshRoute,
	type RefreshDeps,
	type RefreshPolicy,
	type RefreshEvent,
} from "./refresh-job.js";

type IntervalHandle = unknown;

export interface SchedulerDeps {
	/** Enumerate the routes to consider this pass (caller wires to the route store). */
	loadRoutes: () => Promise<RefreshRoute[]>;
	/** The refresh job's deps, minus the per-pass clock (the scheduler supplies `now`). */
	refresh: Omit<RefreshDeps, "now">;
	policy?: RefreshPolicy;
	/** Cadence; defaults to the paper's 6h. */
	intervalMs?: number;
	/** Clock; defaults to Date.now. */
	now?: () => number;
	/** Observer for each pass's events (logging/telemetry). */
	onEvents?: (events: RefreshEvent[]) => void;
	/** Injected timer (testability); defaults to global setInterval/clearInterval. */
	setIntervalFn?: (cb: () => void, ms: number) => IntervalHandle;
	clearIntervalFn?: (handle: IntervalHandle) => void;
}

export interface TrustRefreshScheduler {
	/** Run one refresh pass. Overlap-guarded: returns [] if a pass is already in flight. */
	tick: () => Promise<RefreshEvent[]>;
	/** Begin firing `tick` every interval. Idempotent. */
	start: () => void;
	/** Stop firing. Idempotent. */
	stop: () => void;
	running: () => boolean;
}

export function createTrustRefreshScheduler(deps: SchedulerDeps): TrustRefreshScheduler {
	const intervalMs = deps.intervalMs ?? TRUST_REFRESH_INTERVAL_MS;
	const now = deps.now ?? (() => Date.now());
	const setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
	const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

	let handle: IntervalHandle | null = null;
	let inFlight = false;

	async function tick(): Promise<RefreshEvent[]> {
		if (inFlight) return []; // a sweep is already running — never overlap
		inFlight = true;
		try {
			const routes = await deps.loadRoutes();
			const events = await runTrustRefresh(routes, { ...deps.refresh, now: now() }, deps.policy);
			deps.onEvents?.(events);
			return events;
		} catch (err) {
			console.warn(`[trust-refresh] sweep failed: ${(err as Error).message}`);
			return [];
		} finally {
			inFlight = false;
		}
	}

	function start(): void {
		if (handle !== null) return; // idempotent
		handle = setIntervalFn(() => {
			void tick();
		}, intervalMs);
		// Don't keep the process alive on our account (real timers only).
		(handle as { unref?: () => void } | null)?.unref?.();
	}

	function stop(): void {
		if (handle === null) return;
		clearIntervalFn(handle);
		handle = null;
	}

	return { tick, start, stop, running: () => handle !== null };
}

/**
 * Mount the scheduler only when the operator opted in (UNBROWSE_TRUST_REFRESH=1).
 * Returns the started scheduler, or null when the flag is off. Call this from an
 * entrypoint (CLI/server boot) once a route source + signer are available.
 */
export function maybeStartTrustRefresh(deps: SchedulerDeps): TrustRefreshScheduler | null {
	if (process.env.UNBROWSE_TRUST_REFRESH !== "1") return null;
	const scheduler = createTrustRefreshScheduler(deps);
	scheduler.start();
	console.log(`[trust-refresh] scheduler started — every ${(deps.intervalMs ?? TRUST_REFRESH_INTERVAL_MS) / 3_600_000}h`);
	return scheduler;
}
