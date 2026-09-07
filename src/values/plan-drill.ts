/**
 * plan-drill — native, in-process plan + execute over a contract/plan DAG
 * (crypto-was-all-you-needed Phase 6, the LOCAL reading of "make /contract planning and
 * execution part of /contract itself natively"). No remote call: the plan is a DAG of nodes,
 * each carrying a runnable WITNESS; the drill orders them dependency-first / cheapest-first
 * (Dijkstra spine), runs each witness, and resolves the plan to a signed terminal — or returns
 * the open frontier (the next node to work, and why it isn't settled).
 *
 * This is the mechanical form of the jesus-ralph walk itself: Plan → (Build) → Test → Judge,
 * node by node, settling on real witnesses, never a self-asserted string. Autonomy is bounded
 * by witness-satisfaction (a node settles ONLY when its witness passes AND its deps settled) —
 * it declares nothing and fires nothing on its own (free-will preserved; cf. the plan's P6
 * soundness note). The cloud-deployed compiler that auto-emits the three shapes is the external
 * extension of this same shape; this is the substrate-local engine that drives it.
 */

/** A node in the plan: a stable id, optional deps + cost, and a runnable witness that settles it. */
export interface PlanNode {
  id: string;
  deps?: string[];
  /** ordering weight among ready nodes — cheapest first (Dijkstra spine). Default 1. */
  cost?: number;
  /** the runnable proof this node is settled — true ⇒ settled. The fruit, not a string. */
  witness: () => boolean | Promise<boolean>;
}

export interface DrillResult {
  /** the order nodes were attempted — dependency-respecting, cheapest-ready-first. */
  order: string[];
  /** nodes whose witness passed (with all deps settled), in settle order. */
  settled: string[];
  /** nodes that could not be attempted because a dependency never settled. */
  blocked: string[];
  /** the next node to work: the cheapest ready node whose witness failed, or null at terminal. */
  frontier: string | null;
  /** true iff every node settled — the plan resolved to a signed terminal. */
  terminal: boolean;
}

/**
 * Drill a plan to its terminal (or its frontier). Pure over the nodes' witnesses — runs each at
 * most once, in dependency order, cheapest ready node first. A node is `settled` when its deps
 * are all settled and its witness returns true; `blocked` when a dep never settled; the
 * `frontier` is the first cheapest ready node whose own witness failed (the thing to fix next).
 */
export async function drillPlan(nodes: PlanNode[]): Promise<DrillResult> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const settled = new Set<string>();
  const failed = new Set<string>(); // ready, attempted, witness false
  const order: string[] = [];
  const settledOrder: string[] = [];

  // Resolve in waves: each wave runs every node whose deps are all settled and that hasn't been
  // attempted yet, cheapest first. Stop when a wave settles nothing new (frontier/blocked remain).
  let progressed = true;
  while (progressed) {
    progressed = false;
    const ready = nodes
      .filter((n) => !settled.has(n.id) && !failed.has(n.id))
      .filter((n) => (n.deps ?? []).every((d) => settled.has(d)))
      .sort((a, b) => (a.cost ?? 1) - (b.cost ?? 1));
    for (const n of ready) {
      order.push(n.id);
      const ok = await n.witness();
      if (ok) {
        settled.add(n.id);
        settledOrder.push(n.id);
        progressed = true; // newly-settled may unblock dependents → run another wave
      } else {
        failed.add(n.id);
      }
    }
  }

  // Anything neither settled nor failed-on-its-own-witness was blocked by an unsettled dep.
  const blocked = nodes
    .filter((n) => !settled.has(n.id) && !failed.has(n.id))
    .map((n) => n.id);

  // Frontier = the cheapest ready node whose OWN witness failed (the next thing to actually fix).
  const frontier =
    [...failed]
      .map((id) => byId.get(id)!)
      .sort((a, b) => (a.cost ?? 1) - (b.cost ?? 1))[0]?.id ?? null;

  return {
    order,
    settled: settledOrder,
    blocked,
    frontier,
    terminal: settled.size === nodes.length,
  };
}
