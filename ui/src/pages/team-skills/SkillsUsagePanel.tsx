import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { skillsTelemetryApi, type SkillsUsageResult, type UsageHarness } from "@/api/skillsTelemetry";
import { cn } from "@/lib/utils";

const WINDOWS = [7, 30, 90, 365] as const;
const HARNESSES: UsageHarness[] = ["claude", "codex", "zcode"];

/**
 * The counting rule is frozen (MUL-553/MUL-570): only explicit Skill tool calls
 * count. Codex consumes skills by reading SKILL.md with `sed`, which emits no
 * such call, so its column is structurally zero — say that beside the number or
 * it reads as "nobody uses skills in Codex".
 */
export const CODEX_ZERO_NOTE =
  "Codex 一列结构性为 0：它没有 Skill 工具，消费技能靠直接读 SKILL.md，被口径（只算显式 Skill 调用）排除。这不是「Codex 没人用技能」。";

function usageBar(total: number, max: number): string {
  return max > 0 ? `${Math.max(2, Math.round((total / max) * 100))}%` : "0%";
}

export function SkillsUsagePanel({ companyId }: { companyId: string }) {
  const [days, setDays] = useState<number>(30);
  const query = useQuery<SkillsUsageResult>({
    queryKey: ["skills-telemetry", "usage", companyId, days],
    queryFn: () => skillsTelemetryApi.usage(companyId, days),
    // A cold scan walks every transcript on the box; refetching on focus would
    // pay that again for a page nobody changed.
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

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
        {query.isFetching ? (
          <span className="text-xs text-muted-foreground">扫描中…（首次可能要 20 秒以上）</span>
        ) : null}
      </div>

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
                  <th className="px-3 py-2 text-right font-medium">合计</th>
                  <th className="px-3 py-2 text-right font-medium">claude</th>
                  <th className="px-3 py-2 text-right font-medium" title={CODEX_ZERO_NOTE}>
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
            * {CODEX_ZERO_NOTE}
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
