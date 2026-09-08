import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { skillsTelemetryApi, type SkillsUsageResult, type UsageHarness } from "@/api/skillsTelemetry";
import { cn } from "@/lib/utils";

const WINDOWS = [7, 30, 90, 365] as const;
const HARNESSES: UsageHarness[] = ["claude", "codex", "zcode"];

/**
 * Two calibres in one table (MUL-581). Claude and ZCode count explicit Skill
 * tool calls; Codex has no Skill tool, so it counts sessions that read the
 * skill's SKILL.md. Left unsaid, the sum reads as one measurement.
 */
export const CODEX_CALIBER_NOTE =
  "两列口径不同：claude / zcode 数的是显式 Skill 工具调用（同一会话内调 N 次算 N 次）；codex 没有 Skill 工具，数的是「读过该技能 SKILL.md 的会话数」（一个会话里读多少遍都算 1）。量级可比，单位不可比。";

function usageBar(total: number, max: number): string {
  return max > 0 ? `${Math.max(2, Math.round((total / max) * 100))}%` : "0%";
}

export function SkillsUsagePanel({ companyId }: { companyId: string }) {
  const [days, setDays] = useState<number>(30);
  const queryClient = useQueryClient();
  const queryKey = ["skills-telemetry", "usage", companyId, days];
  const query = useQuery<SkillsUsageResult>({
    queryKey,
    queryFn: () => skillsTelemetryApi.usage(companyId, days),
    // A cold scan walks every transcript on the box; refetching on focus would
    // pay that again for a page nobody changed.
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  // Written straight into the query cache rather than invalidating: an
  // invalidate would refetch *without* `refresh`, and the server would answer
  // that second request from the memory entry this scan just filled.
  const refresh = useMutation({
    mutationFn: () => skillsTelemetryApi.usage(companyId, days, { refresh: true }),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });
  const busy = query.isFetching || refresh.isPending;

  const result = query.data;
  const max = result?.skills[0]?.total ?? 0;
  const scannedFiles = result
    ? HARNESSES.reduce((sum, harness) => sum + result.scanned[harness].files, 0)
    : 0;
  const parsedFiles = result
    ? HARNESSES.reduce((sum, harness) => sum + result.scanned[harness].parsed, 0)
    : 0;

  return (
    <div className="space-y-3" data-testid="skills-usage-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">时间窗</span>
        {WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setDays(option)}
            aria-pressed={days === option}
            className={cn(
              "rounded-md border px-2 py-0.5 text-xs transition-colors",
              days === option
                ? "border-foreground/20 bg-accent font-medium text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {option} 天
          </button>
        ))}
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={busy}
          data-testid="skills-usage-refresh"
          className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refresh.isPending ? "刷新中…" : "刷新"}
        </button>
        {busy ? (
          <span className="text-xs text-muted-foreground">
            {refresh.isPending ? "正在跳过缓存全量重扫…（约 20 秒）" : "扫描中…（首次可能要 20 秒以上）"}
          </span>
        ) : null}
      </div>

      {query.isError ? (
        <p className="text-sm text-destructive">读取失败：{(query.error as Error).message}</p>
      ) : null}
      {refresh.isError ? (
        <p className="text-sm text-destructive">刷新失败：{(refresh.error as Error).message}</p>
      ) : null}

      {result ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">技能</th>
                  <th className="px-3 py-2 text-right font-medium">合计</th>
                  <th className="px-3 py-2 text-right font-medium">claude</th>
                  <th className="px-3 py-2 text-right font-medium" title={CODEX_CALIBER_NOTE}>
                    codex <span className="text-muted-foreground">*</span>
                  </th>
                  <th className="px-3 py-2 text-right font-medium">zcode</th>
                  <th className="w-32 px-3 py-2 text-left font-medium">占比</th>
                </tr>
              </thead>
              <tbody>
                {result.skills.map((row) => (
                  <tr key={row.skill} className="border-b border-border/60 last:border-b-0" data-testid="skills-usage-row">
                    <td className="px-3 py-1.5 font-mono text-xs text-foreground">{row.skill}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{row.total}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{row.byHarness.claude}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{row.byHarness.codex}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{row.byHarness.zcode}</td>
                    <td className="px-3 py-1.5">
                      <span className="block h-1.5 rounded-full bg-foreground/70" style={{ width: usageBar(row.total, max) }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">这个时间窗内没有记录到 Skill 调用。</p>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {result.skills.length} 个技能，{result.totalCalls} 次调用，自 {new Date(result.since).toLocaleString()} 起
            —— 窗口内 {scannedFiles} 个会话文件，其中 {parsedFiles} 个本次解析（其余走缓存）。仅本机，子 Agent 计入。
          </p>
          <p className="text-xs text-muted-foreground" data-testid="codex-caliber-note">
            * {CODEX_CALIBER_NOTE}
          </p>
          {result.unreadable.length > 0 ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {result.unreadable.length} 个会话文件读不出来，下面的计数低于真值：
              <ul className="mt-1 space-y-0.5 font-mono">
                {result.unreadable.map((entry) => (
                  <li key={entry.file}>
                    {entry.file}: {entry.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
