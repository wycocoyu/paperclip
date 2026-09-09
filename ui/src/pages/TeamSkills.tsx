import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { companySkillsApi } from "../api/companySkills";
import { SkillCardIcon } from "@/components/SkillCardIcon";
import { cn } from "@/lib/utils";
import { SkillsStatusPanel } from "./team-skills/SkillsStatusPanel";
import { SkillsUsagePanel } from "./team-skills/SkillsUsagePanel";

/**
 * The dedicated Team Skills view inside TeamWorkSpace: the company skill
 * library only. Cards follow the /skills discovery-card recipe (icon,
 * mono name, author line, source chip) so the two surfaces read the same;
 * full management stays on /skills.
 */
const VIEWS = [
  { id: "library", label: "技能库" },
  { id: "usage", label: "调用统计" },
  { id: "status", label: "投影状态" },
] as const;

const OWNERSHIP_LABELS = { team: "团队资产", builtin: "Paperclip 内置", plugin: "插件" } as const;

function groupOf(key: string) {
  return key.startsWith("company/") ? "team" : key.startsWith("paperclipai/") ? "builtin" : "plugin";
}

export function TeamSkills() {
  const { selectedCompanyId } = useCompany();
  const skillsQuery = useQuery({
    queryKey: ["team-skills", selectedCompanyId],
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const skills = (skillsQuery.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  const counts = { all: skills.length, team: 0, builtin: 0, plugin: 0 };
  for (const skill of skills) counts[groupOf(skill.key)] += 1;
  const TABS = [
    { id: "all", label: `全部 ${counts.all}` },
    { id: "team", label: `团队资产 ${counts.team}` },
    { id: "builtin", label: `Paperclip 内置 ${counts.builtin}` },
    { id: "plugin", label: `插件 ${counts.plugin}` },
  ] as const;
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("all");
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("library");
  const visible = tab === "all" ? skills : skills.filter((skill) => groupOf(skill.key) === tab);

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Team Skills</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          公司技能库（团队共同资产）。完整管理（版本/测试/挂载到 agent）在 <Link to="/skills" className="text-primary underline-offset-2 hover:underline">Skills</Link>。
        </p>
      </div>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border pb-2" data-testid="team-skill-views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              view === v.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === "usage" && selectedCompanyId ? (
        // The library this page already loaded is what tells the usage table
        // which of its rows we own the description of; `undefined` until it
        // lands keeps the panel's filter from claiming an empty library.
        // Narrowed by the same `groupOf` that labels the tab below, so the two
        // surfaces cannot disagree on what counts as ours: the bundled
        // `paperclipai/*` entries are in the library but read-only, and a row
        // whose description cannot be trimmed is noise in a table read to
        // decide what to trim.
        <SkillsUsagePanel
          companyId={selectedCompanyId}
          teamSkills={skillsQuery.data?.filter((skill) => groupOf(skill.key) === "team")}
        />
      ) : null}
      {view === "status" && selectedCompanyId ? <SkillsStatusPanel companyId={selectedCompanyId} /> : null}
      {view !== "library" ? null : (
        <>
        <div role="tablist" className="flex flex-wrap gap-1 border-b border-border pb-2" data-testid="team-skill-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                tab === t.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {skillsQuery.isLoading ? <p className="text-xs text-muted-foreground">加载…</p> : null}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(22rem,1fr))]">
          {visible.map((skill) => (
            <Link
              key={skill.id}
              to={`/skills/${skill.id}`}
              className="group flex h-full min-h-(--sz-11_5rem) flex-col rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:shadow-md"
              data-testid="team-skill-card"
            >
              <div className="flex min-w-0 items-start gap-3">
                <SkillCardIcon card={skill} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm font-medium text-foreground">{skill.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {skill.authorName ? `by ${skill.authorName}` : OWNERSHIP_LABELS[groupOf(skill.key)]}
                  </div>
                  <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted-foreground">
                    {skill.description ?? "（无描述）"}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-border px-2 py-px text-(length:--text-micro) text-muted-foreground">
                  {OWNERSHIP_LABELS[groupOf(skill.key)]}
                </span>
              </div>
            </Link>
          ))}
        </div>
        {!skillsQuery.isLoading && visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">这个分组下没有技能。</p>
        ) : null}
        </>
      )}
    </div>
  );
}
