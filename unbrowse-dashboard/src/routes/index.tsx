import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, type SortingState, useReactTable } from "@tanstack/react-table";
import { env } from "cloudflare:workers";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { isBranch } from "~/lib/api.mjs";
import { listRuns } from "~/lib/db.mjs";

const REPO = "https://github.com/unbrowse-ai/unbrowse-core";
const BRANCHES = ["staging", "main", "all"];
type Branch = string;
type Run = {
  run_id: number;
  workflow: string;
  branch: string;
  sha: string;
  event: string;
  conclusion: string;
  finished_at: string;
  wall_s: number | null;
  metrics: Record<string, number>;
};

const getRuns = createServerFn({ method: "GET" })
  .validator((branch: Branch) => (isBranch(branch) ? branch : "staging"))
  .handler(async ({ data }) => (await listRuns((env as unknown as { DB: D1Database }).DB, { branch: data, days: 90 })) as Run[]);

const runsQuery = (branch: Branch) => queryOptions({ queryKey: ["runs", branch], queryFn: () => getRuns({ data: branch }) });

export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): { branch?: Branch } => (isBranch(s.branch) && s.branch !== "staging" ? { branch: s.branch as string } : {}),
  loaderDeps: ({ search }) => ({ branch: search.branch ?? "staging" }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(runsQuery(deps.branch)),
  component: Dashboard,
});

const C = {
  right: "#2f9e44",
  wrong: "#e03131",
  aside: "#adb5bd",
  failed: "#f08c00",
  browser: "#4dabf7",
  walled: "#868e96",
  unknown: "#dee2e6",
  line: "#364fc7",
};
const WF_COLOR: Record<string, string> = { CI: "#364fc7", Coverage: "#0ca678", QA: "#ae3ec9", "Gate bank": "#f76707", Bank: "#495057" };

const runUrl = (id: number) => `${REPO}/actions/runs/${id}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });
const m = (r: Run, k: string) => r.metrics[k];
const has = (k: string) => (r: Run) => typeof r.metrics[k] === "number";

function summary(r: Run): string {
  const g = (k: string) => m(r, k);
  if (has("slice_tasks")(r)) return `slice ${g("slice_right")}/${g("slice_tasks")} right, ${g("slice_wrong")} wrong`;
  if (has("full_tasks")(r)) return `full ${g("full_right")}/${g("full_tasks")} right, ${g("full_wrong")} wrong`;
  if (has("qa_checks_total")(r)) return `${g("qa_checks_pass")}/${g("qa_checks_total")} checks`;
  if (has("hard_wrong")(r)) return `hard sites ${g("hard_right")} right, ${g("hard_wrong")} wrong, ${g("hard_browser")} browser, ${g("hard_walled")} walled`;
  if (has("bank_total")(r)) return `${g("bank_pass")}/${g("bank_total")} sites`;
  if (has("coverage_pct")(r)) return `${g("coverage_pct")}% lines`;
  return "";
}

type Series = { key: string; name: string; color: string };

function Panel({ title, value, empty, children }: { title: string; value?: string; empty?: boolean; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>
        {title}
        {value && <span className="value">{value}</span>}
      </h2>
      <div className="chart">{empty ? <p className="empty">No runs yet</p> : children}</div>
    </section>
  );
}

const open = (d: unknown) => {
  const id = (d as { payload?: { run_id?: number } })?.payload?.run_id;
  if (id) window.open(runUrl(id), "_blank", "noopener");
};

function Stacked({ runs, series }: { runs: Run[]; series: Series[] }) {
  const data = runs.map((r) => ({ run_id: r.run_id, label: when(r.finished_at), ...Object.fromEntries(series.map((s) => [s.name, r.metrics[s.key] ?? 0])) }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
        <CartesianGrid vertical={false} stroke="#eee" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
        <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
        <Tooltip />
        {series.map((s) => (
          <Bar key={s.name} dataKey={s.name} stackId="a" fill={s.color} onClick={open} cursor="pointer" isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function Lines({ data, keys, unit, log }: { data: Record<string, unknown>[]; keys: { name: string; color: string }[]; unit: string; log?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
        <CartesianGrid vertical={false} stroke="#eee" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
        <YAxis tick={{ fontSize: 10 }} unit={unit} scale={log ? "log" : "auto"} domain={log ? [1, "auto"] : ["auto", "auto"]} allowDataOverflow={log} />
        <Tooltip />
        {keys.map((k) => (
          <Line
            key={k.name}
            dataKey={k.name}
            stroke={k.color}
            dot={{ r: 2 }}
            activeDot={{ r: 5, onClick: (_e: unknown, d: unknown) => open(d), cursor: "pointer" }}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

const col = createColumnHelper<Run>();
const columns = [
  col.accessor("finished_at", { header: "Finished", cell: (c) => when(c.getValue()) }),
  col.accessor("workflow", { header: "Workflow", cell: (c) => <a href={runUrl(c.row.original.run_id)}>{c.getValue()}</a> }),
  col.accessor("conclusion", { header: "Result", cell: (c) => <span className={`pill ${c.getValue()}`}>{c.getValue()}</span> }),
  col.display({ id: "numbers", header: "Numbers", cell: (c) => summary(c.row.original) }),
  col.accessor("wall_s", { header: "Minutes", cell: (c) => (c.getValue() == null ? "" : Math.round((c.getValue() as number) / 60)) }),
  col.accessor((r) => r.metrics.cost_usd, { id: "cost", header: "Cost", cell: (c) => (c.getValue() == null ? "" : `$${(c.getValue() as number).toFixed(2)}`) }),
  col.accessor("sha", { header: "Commit", cell: (c) => <a href={`${REPO}/commit/${c.getValue()}`}>{c.getValue().slice(0, 7)}</a> }),
  col.accessor("branch", { header: "Branch" }),
];

function RunsTable({ runs }: { runs: Run[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "finished_at", desc: true }]);
  const table = useReactTable({ data: runs, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  return (
    <div className="table">
      <table>
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id}>
              {g.headers.map((h) => (
                <th key={h.id} aria-sort={h.column.getIsSorted() === "asc" ? "ascending" : h.column.getIsSorted() === "desc" ? "descending" : undefined}>
                  <button type="button" onClick={h.column.getToggleSortingHandler()}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </button>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Dashboard() {
  const { branch } = Route.useLoaderDeps();
  const { data } = useSuspenseQuery(runsQuery(branch));
  // A cancelled run was replaced by a newer push and holds no result.
  const finished = data.filter((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped");
  const runs = [...finished].reverse(); // oldest first, for charts
  const of = (wf: string, k: string) => runs.filter((r) => r.workflow === wf && has(k)(r));
  const last = (rs: Run[]) => rs[rs.length - 1];

  const slice = of("Gate bank", "slice_tasks");
  const full = of("Gate bank", "full_tasks");
  const qa = of("QA", "qa_checks_total");
  const hard = of("Bank", "hard_wrong");
  const bank = of("Bank", "bank_total");
  const cov = of("Coverage", "coverage_pct");
  const costed = runs.filter(has("cost_usd"));
  const week = Date.now() - 7 * 86400_000;
  const weekCost = costed.filter((r) => Date.parse(r.finished_at) >= week).reduce((s, r) => s + r.metrics.cost_usd, 0);

  const bench = (p: "slice" | "full"): Series[] => [
    { key: `${p}_right`, name: "right", color: C.right },
    { key: `${p}_wrong`, name: "wrong", color: C.wrong },
    { key: `${p}_aside`, name: "set aside", color: C.aside },
    { key: `${p}_error`, name: "error", color: C.failed },
    { key: `${p}_fail`, name: "honest fail", color: C.unknown },
  ];
  const score = (r: Run | undefined, p: string) => (r ? `${m(r, `${p}_right`)}/${m(r, `${p}_tasks`)}` : undefined);
  const workflows = Object.keys(WF_COLOR).filter((w) => runs.some((r) => r.workflow === w && r.wall_s != null));
  const wall = runs.filter((r) => r.wall_s != null).map((r) => ({ run_id: r.run_id, label: when(r.finished_at), [r.workflow]: Math.max(1, Math.round((r.wall_s as number) / 60)) }));

  return (
    <main>
      <header>
        <h1>Unbrowse tests</h1>
        <nav aria-label="Branch">
          {BRANCHES.map((b) => (
            <a key={b} href={b === "staging" ? "/" : `/?branch=${b}`} aria-current={b === branch ? "page" : undefined}>
              {b}
            </a>
          ))}
        </nav>
      </header>
      {runs.length === 0 ? (
        <p className="empty">No runs on {branch} in the last 90 days.</p>
      ) : (
        <div className="grid">
          <Panel title="Benchmark slice" empty={!slice.length} value={score(last(slice), "slice")}>
            <Stacked runs={slice} series={bench("slice")} />
          </Panel>
          <Panel title="Full benchmark" empty={!full.length} value={score(last(full), "full")}>
            <Stacked runs={full} series={bench("full")} />
          </Panel>
          <Panel title="Agent QA" empty={!qa.length} value={last(qa) && `${m(last(qa), "qa_checks_pass")}/${m(last(qa), "qa_checks_total")}`}>
            <Stacked
              runs={qa.map((r) => ({ ...r, metrics: { ...r.metrics, qa_checks_fail: r.metrics.qa_checks_total - r.metrics.qa_checks_pass } }))}
              series={[
                { key: "qa_checks_pass", name: "pass", color: C.right },
                { key: "qa_checks_fail", name: "fail", color: C.wrong },
              ]}
            />
          </Panel>
          <Panel title="30 hard sites" empty={!hard.length} value={last(hard) && `${m(last(hard), "hard_right")}/${["hard_right", "hard_wrong", "hard_browser", "hard_walled", "hard_unknown"].reduce((s, k) => s + (m(last(hard), k) ?? 0), 0)}`}>
            <Stacked
              runs={hard}
              series={[
                { key: "hard_right", name: "right", color: C.right },
                { key: "hard_wrong", name: "wrong", color: C.wrong },
                { key: "hard_browser", name: "needs a browser", color: C.browser },
                { key: "hard_walled", name: "walled", color: C.walled },
                { key: "hard_unknown", name: "unknown", color: C.unknown },
              ]}
            />
          </Panel>
          <Panel title="Live-site bank" empty={!bank.length} value={last(bank) && `${m(last(bank), "bank_pass")}/${m(last(bank), "bank_total")}`}>
            <Stacked
              runs={bank.map((r) => ({ ...r, metrics: { ...r.metrics, bank_fail: r.metrics.bank_total - r.metrics.bank_pass } }))}
              series={[
                { key: "bank_pass", name: "pass", color: C.right },
                { key: "bank_fail", name: "not passing", color: C.wrong },
              ]}
            />
          </Panel>
          <Panel title="Line coverage" empty={!cov.length} value={last(cov) && `${m(last(cov), "coverage_pct")}%`}>
            <Lines data={cov.map((r) => ({ run_id: r.run_id, label: when(r.finished_at), lines: m(r, "coverage_pct") }))} keys={[{ name: "lines", color: C.line }]} unit="%" />
          </Panel>
          <Panel title="Minutes per run">
            <Lines data={wall} keys={workflows.map((w) => ({ name: w, color: WF_COLOR[w] }))} unit="" log />
          </Panel>
          <Panel title="Model cost" value={`$${weekCost.toFixed(2)} / 7 days`}>
            <Stacked runs={costed.map((r) => ({ ...r, metrics: { [`cost_${r.workflow}`]: Math.round(r.metrics.cost_usd * 100) / 100 } }))} series={["QA", "Gate bank"].map((w) => ({ key: `cost_${w}`, name: w, color: WF_COLOR[w] }))} />
          </Panel>
        </div>
      )}
      {runs.length > 0 && <RunsTable runs={finished.slice(0, 60)} />}
    </main>
  );
}
