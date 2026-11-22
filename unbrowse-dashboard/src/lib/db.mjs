// The dashboard's store on D1 (anything with D1's prepare/bind/run/all/batch works, so tests use a stand-in).

export async function saveRun(db, r, now = new Date().toISOString()) {
  const upsert = db
    .prepare(
      `INSERT INTO runs (run_id, attempt, workflow, branch, sha, event, conclusion, started_at, finished_at, wall_s, metrics, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT (run_id) DO UPDATE SET attempt = excluded.attempt, workflow = excluded.workflow, branch = excluded.branch,
         sha = excluded.sha, event = excluded.event, conclusion = excluded.conclusion, started_at = excluded.started_at,
         finished_at = excluded.finished_at, wall_s = excluded.wall_s, metrics = excluded.metrics, received_at = excluded.received_at
       WHERE excluded.attempt >= runs.attempt`,
    )
    .bind(r.run_id, r.attempt, r.workflow, r.branch, r.sha, r.event, r.conclusion, r.started_at, r.finished_at, r.wall_s, JSON.stringify(r.metrics), now);
  const stmts = [upsert];
  // The deploy gate posts made-up runs on gate-* branches; a day later they go.
  if (r.branch.startsWith("gate-")) {
    stmts.push(db.prepare("DELETE FROM sites WHERE run_id IN (SELECT run_id FROM runs WHERE branch LIKE 'gate-%' AND received_at < ?1)").bind(new Date(Date.parse(now) - 86400_000).toISOString()));
    stmts.push(db.prepare("DELETE FROM runs WHERE branch LIKE 'gate-%' AND received_at < ?1").bind(new Date(Date.parse(now) - 86400_000).toISOString()));
  }
  if (r.sites.length) {
    stmts.push(db.prepare("DELETE FROM sites WHERE run_id = ?1").bind(r.run_id));
    for (const s of r.sites) {
      stmts.push(db.prepare("INSERT INTO sites (run_id, site, label, seconds) VALUES (?1, ?2, ?3, ?4)").bind(r.run_id, s.site, s.label, s.seconds));
    }
  }
  await db.batch(stmts);
}

// branch "all" means every branch but the deploy gate's made-up ones. Newest first.
export async function listRuns(db, { branch = "staging", days = 60 } = {}, now = Date.now()) {
  const since = new Date(now - days * 86400_000).toISOString();
  const q =
    branch === "all"
      ? db.prepare("SELECT * FROM runs WHERE finished_at >= ?1 AND branch NOT LIKE 'gate-%' ORDER BY finished_at DESC LIMIT 2000").bind(since)
      : db.prepare("SELECT * FROM runs WHERE branch = ?1 AND finished_at >= ?2 ORDER BY finished_at DESC LIMIT 2000").bind(branch, since);
  const { results } = await q.all();
  return results.map((r) => ({ ...r, metrics: JSON.parse(r.metrics || "{}") }));
}

export async function listSites(db, runId) {
  const { results } = await db.prepare("SELECT site, label, seconds FROM sites WHERE run_id = ?1 ORDER BY site").bind(runId).all();
  return results;
}
