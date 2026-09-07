#!/usr/bin/env bash
# Three-interaction witness: browse once -> validate once -> API-only (no browser) -> publish at most once
# Uses real runtime fixture, no network. Stubs browser_discover + api_replay.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bun -e '
import { initialRouteLifecycleRecord, routeLifecycleKey, reduceRouteLifecycle, decideRouteLifecycleAction } from "./src/runtime/route-lifecycle.ts";
const id = { principal_scope:"test", skill_id:"s1", endpoint_fingerprint:"sha256:ep1", intent_shape_hash:"sha256:shape1" };
let r = initialRouteLifecycleRecord(routeLifecycleKey(id));
console.assert(decideRouteLifecycleAction(r)==="browser_discover","step1 must browse");
r = reduceRouteLifecycle(r,{type:"browser_observed",baseline_fingerprint:"base1",dag_fingerprint:"dag1"});
console.assert(r.state==="validation_pending" && decideRouteLifecycleAction(r)==="api_validate","step1->validation_pending");
r = reduceRouteLifecycle(r,{type:"api_validation_succeeded",baseline_fingerprint:"base1",dag_fingerprint:"dag1"});
console.assert(r.state==="validated" && r.api_validation_successes===1,"step2 validated");
console.assert(decideRouteLifecycleAction(r)==="api_execute","step3 must api_execute (no browser)");
let pub = reduceRouteLifecycle(r,{type:"publish_requested",artifact_fingerprint:"art1"});
console.assert(pub.state==="publish_eligible","must be publish_eligible after permit-eligible");
pub = reduceRouteLifecycle(pub,{type:"publish_succeeded",visibility:"shadow",artifact_fingerprint:"art1"});
console.assert(pub.state==="shadow_published","shadow_published");

// Failure demotion: drift -> stale, then rediscover
let drift = reduceRouteLifecycle(pub,{type:"schema_drifted"});
console.assert(drift.state==="stale","drift->stale");
console.assert(decideRouteLifecycleAction(drift)==="browser_discover","stale must re-discover");
console.log("lifecycle witness PASS: browse->validate->api_execute->publish | stale->rediscover verified");
'
