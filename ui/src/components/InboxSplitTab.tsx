import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { Agent, Issue } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useCompany } from "@/context/CompanyContext";
import { timeAgo } from "@/lib/timeAgo";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { deriveInitials } from "./Identity";
import { IssueDetail } from "../pages/IssueDetail";

/**
 * The inbox 会话 tab (MUL-537): the list and the issue side by side, so working
 * through a batch costs one click per item instead of a navigation there and
 * a navigation back. The other tabs keep their single-column, navigate-away
 * behaviour; this one shares their feed and only changes how it is read.
 *
 * The selected issue lives in `?issue=<id>` rather than component state so a
 * reload, a back button, or a pasted link all land on the same pane.
 */

const SELECTED_PARAM = "issue";

/** First non-empty line of the description — the list's preview line. */
function previewLine(issue: Issue): string | null {
  const raw = issue.description;
  if (typeof raw !== "string") return null;
  const line = raw
    .split("\n")
    .map((chunk) => chunk.replace(/^>\s*/, "").trim())
    .find(Boolean);
  return line ? line.slice(0, 140) : null;
}

/** Sort/display key. Timestamps arrive as Date or ISO string depending on the
 * cache path, so normalise to epoch ms rather than comparing mixed types. */
function activityAt(issue: Issue): number {
  const raw = issue.lastActivityAt ?? issue.lastExternalCommentAt ?? issue.updatedAt;
  const time = new Date(raw as string | Date).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** Provider logo off agent metadata; anything non-string is treated as absent. */
function agentIconUrl(agent: Agent | undefined): string | null {
  const icon = (agent?.metadata as Record<string, unknown> | undefined)?.customIcon;
  return typeof icon === "string" && icon.length > 0 ? icon : null;
}

function InboxSplitRow({
  issue,
  agent,
  selected,
  onSelect,
}: {
  issue: Issue;
  agent: Agent | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const preview = previewLine(issue);
  const unread = issue.isUnreadForMe === true;
  const actorName = agent?.name ?? issue.identifier ?? "?";
  const avatarUrl = agentIconUrl(agent);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
          selected ? "bg-accent" : "hover:bg-accent/50",
        )}
      >
        <Avatar className="mt-0.5 size-6 shrink-0 rounded-md">
          {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
          <AvatarFallback className="rounded-md text-[10px]">
            {deriveInitials(actorName)}
          </AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Title first, actor and time on the meta line: the title is what
              the reader scans for, so it must not share the row with anything
              that can push it out of view. */}
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                unread ? "font-semibold text-foreground" : "text-foreground",
              )}
            >
              {issue.title}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {timeAgo(new Date(activityAt(issue)))}
            </span>
            {unread ? (
              <span aria-label="未读" className="size-1.5 shrink-0 rounded-full bg-primary" />
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {actorName}
            {preview ? ` · ${preview}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

export function InboxSplitTab({ issues }: { issues: readonly Issue[] }) {
  const { selectedCompanyId } = useCompany();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get(SELECTED_PARAM);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!, { includeTerminated: true }),
    enabled: Boolean(selectedCompanyId),
  });

  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const ordered = useMemo(
    () => [...issues].sort((a, b) => activityAt(b) - activityAt(a)),
    [issues],
  );

  // Land on the newest row so the pane is never blank on first open. Replace,
  // not push: an auto-selection is not a step the back button should undo.
  const firstId = ordered[0]?.id ?? null;
  const selectionMissing = selectedId != null && !ordered.some((issue) => issue.id === selectedId);
  useEffect(() => {
    if (!firstId) return;
    if (selectedId != null && !selectionMissing) return;
    const next = new URLSearchParams(searchParams);
    next.set(SELECTED_PARAM, firstId);
    setSearchParams(next, { replace: true });
  }, [firstId, selectedId, selectionMissing, searchParams, setSearchParams]);

  const activeId = selectionMissing ? firstId : (selectedId ?? firstId);

  const select = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(SELECTED_PARAM, id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div
      className="flex min-h-0 flex-1 gap-0 overflow-hidden"
      data-testid="inbox-split-tab"
    >
      <div className="w-[22rem] shrink-0 overflow-y-auto border-r border-border">
        {ordered.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">收件箱是空的。</p>
        ) : (
          <ul className="space-y-0.5 p-2">
            {ordered.map((issue) => (
              <InboxSplitRow
                key={issue.id}
                issue={issue}
                agent={issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) : undefined}
                selected={issue.id === activeId}
                onSelect={() => select(issue.id)}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {activeId ? (
          // Remount per issue: IssueDetail holds per-issue refs (last-read,
          // scroll anchors) that a prop swap alone would carry across rows.
          <IssueDetail key={activeId} issueId={activeId} embedded />
        ) : (
          <p className="px-4 py-6 text-sm text-muted-foreground">左边选一条看详情。</p>
        )}
      </div>
    </div>
  );
}
