import { useQuery } from "@tanstack/react-query";
import { skillsTelemetryApi, type SkillStatusRow, type SkillsStatusResult } from "@/api/skillsTelemetry";
import { cn } from "@/lib/utils";

/** Same five states `skills status` prints, with the glyph spelled out. */
const LINK_STATES: Record<string, { glyph: string; label: string; tone: string }> = {
  correct: { glyph: "●", label: "已投影", tone: "text-emerald-600 dark:text-emerald-400" },
  absent: { glyph: "–", label: "未投影", tone: "text-muted-foreground" },
  dangling: { glyph: "!", label: "断链", tone: "text-destructive" },
  elsewhere: { glyph: "~", label: "指向另一个 checkout", tone: "text-amber-600 dark:text-amber-400" },
  occupied: { glyph: "×", label: "被真实目录占用", tone: "text-destructive" },
};

/**
 * Every `~` at once usually means one thing — the terminals point at a
 * different checkout of the same skills — and N identical rows do not say so.
 * Grouping the link targets by parent turns "all broken" back into one line.
 */
function foreignLinkRoots(result: SkillsStatusResult): Array<[string, number]> {
  const roots = new Map<string, number>();
  for (const row of result.skills) {
    for (const tool of result.tools) {
      const link = row.links[tool];
      if (!link || link.state !== "elsewhere" || !link.to) continue;
      const root = link.to.slice(0, Math.max(0, link.to.lastIndexOf("/"))) || "/";
      roots.set(root, (roots.get(root) ?? 0) + 1);
    }
  }
  return [...roots.entries()].sort((a, b) => b[1] - a[1]);
}

function driftCell(row: SkillStatusRow) {
  if (row.drift === undefined) return <span className="text-muted-foreground" title="没有 sidecar 基线，漂移归 git 管">n/a</span>;
  if (!row.drift) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="text-amber-600 dark:text-amber-400" title={row.drift}>
      本地已改
    </span>
  );
}

function fanoutCell(row: SkillStatusRow) {
  if (row.fanout === "unknown") return <span className="text-muted-foreground">未知</span>;
  if (!row.fanout) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="text-destructive" title={`${row.fanout.lastError}（${row.fanout.lastAttemptAt}）`}>
      失败 ×{row.fanout.attempts}
    </span>
  );
}

export function SkillsStatusPanel({ companyId }: { companyId: string }) {
  const query = useQuery<SkillsStatusResult>({
    queryKey: ["skills-telemetry", "local-status", companyId],
    queryFn: () => skillsTelemetryApi.localStatus(companyId),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const result = query.data;
  const drifted = result?.skills.filter((row) => row.drift) ?? [];

  return (
    <div className="space-y-3" data-testid="skills-status-panel">
      {query.isFetching ? <p className="text-xs text-muted-foreground">读取中…</p> : null}
      {query.isError ? (
        <p className="text-sm text-destructive">读取失败：{(query.error as Error).message}</p>
      ) : null}

      {result ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">技能</th>
                  <th className="px-3 py-2 text-left font-medium">来源</th>
                  {result.tools.map((tool) => (
                    <th key={tool} className="px-3 py-2 text-center font-medium">
                      {tool}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-left font-medium">本地漂移</th>
                  <th className="px-3 py-2 text-left font-medium">扇出</th>
                </tr>
              </thead>
              <tbody>
                {result.skills.map((row) => (
                  <tr key={row.name} className="border-b border-border/60 last:border-b-0" data-testid="skills-status-row">
                    <td className="px-3 py-1.5 font-mono text-xs text-foreground" title={row.source}>
                      {row.name}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">
                      {row.sourceLabel === "team" ? "团队" : "上游"}
                    </td>
                    {result.tools.map((tool) => {
                      const link = row.links[tool];
                      const state = LINK_STATES[link?.state ?? ""] ?? { glyph: "?", label: link?.state ?? "未知", tone: "text-muted-foreground" };
                      return (
                        <td key={tool} className="px-3 py-1.5 text-center">
                          <span className={cn("font-mono", state.tone)} title={`${state.label}${link?.to ? ` → ${link.to}` : ""}`}>
                            {state.glyph}
                          </span>
                        </td>
                      );
                    })}
                    <td className="px-3 py-1.5 text-xs">{driftCell(row)}</td>
                    <td className="px-3 py-1.5 text-xs">{fanoutCell(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            图例：● 已投影 · – 未投影 · ! 断链 · ~ 指向另一个 checkout · × 被真实目录占用；共 {result.skills.length} 个技能，源目录 {result.repoRoot}
          </p>
          {drifted.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-amber-600 dark:text-amber-400">
              {drifted.map((row) => (
                <li key={row.name}>
                  <span className="font-mono">{row.name}</span>：{row.drift}
                </li>
              ))}
            </ul>
          ) : null}
          {foreignLinkRoots(result).map(([root, count]) => (
            <p key={root} className="text-xs text-muted-foreground">
              {count} 个链接指向另一个 checkout：<span className="font-mono">{root}</span>
            </p>
          ))}
          {!result.fanoutAvailable ? (
            <p className="text-xs text-muted-foreground">扇出失败清单不可用：{result.fanoutReason ?? "服务端未响应"}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
