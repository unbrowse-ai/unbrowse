import { listSkills, getStatsSummary, listAgents } from "@/lib/api";
import type { SkillManifest, StatsSummary, AgentProfile } from "@/lib/api";
import { OpsDashboard } from "./dashboard";

export const metadata = {
  title: "OPS // unbrowse",
  robots: "noindex, nofollow",
};

export const revalidate = 30;

export default async function OpsPage() {
  let stats: StatsSummary = { skills: 0, endpoints: 0, domains: 0, executions: 0, agents: 0 };
  let skills: SkillManifest[] = [];
  let agents: AgentProfile[] = [];

  try {
    [stats, skills, agents] = await Promise.all([
      getStatsSummary(),
      listSkills(),
      listAgents(50),
    ]);
  } catch {
    // render with empty data
  }

  return <OpsDashboard stats={stats} skills={skills} agents={agents} />;
}
