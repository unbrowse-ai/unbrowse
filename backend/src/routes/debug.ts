import { Hono } from "hono";
import type { Env } from "../types.js";
import { statsKV } from "../services/kv.js";
export const debugRoutes = new Hono<{ Bindings: Env }>();
debugRoutes.get("/debug/status", async (c) => {
  const kv = statsKV(c.env);
  let agentsCount=0, sessionsCount=0;
  try { let cur: string|undefined; do{ const p=await kv.list({prefix:"agent:",limit:1000,cursor:cur}); agentsCount+=p.keys.length; cur=p.cursor; if(p.list_complete)break;}while(cur);}catch{}
  try { let cur: string|undefined; do{ const p=await kv.list({prefix:"analytics:session:",limit:1000,cursor:cur}); sessionsCount+=p.keys.length; cur=p.cursor; if(p.list_complete)break;}while(cur);}catch{}
  return c.json({ agents_count: agentsCount, sessions_count: sessionsCount });
});
debugRoutes.get("/debug/august-sample", async (c) => {
  const kv = statsKV(c.env);
  const page = await kv.list({ prefix: "agent:", limit: 100 });
  const keys = page.keys.map(k=>k.name);
  const sampleSize = Math.min(40, keys.length);
  let augustInSample=0; let julyInSample=0;
  const samples: Array<{key:string; created_at?:string}>=[];
  for (let i=0;i<sampleSize;i++) {
    const v = await kv.get(keys[i]) as string | null;
    if (!v) continue;
    try { const p=JSON.parse(v) as {created_at?:string}; const ca=p.created_at?.slice(0,10); samples.push({key:keys[i].slice(0,30), created_at: ca}); if(ca?.startsWith("2026-08")) augustInSample++; if(ca?.startsWith("2026-07")) julyInSample++; } catch {}
  }
  const totalAgents = 9921;
  const estAugust = sampleSize>0 ? Math.round((augustInSample/sampleSize)*totalAgents) : 0;
  return c.json({ sample: sampleSize, august_in_sample: augustInSample, july_in_sample: julyInSample, est_august_total: estAugust, total_agents: totalAgents, samples });
});
