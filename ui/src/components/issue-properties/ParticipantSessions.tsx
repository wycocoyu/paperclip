import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { agentCustomIcon } from "@/components/AgentIconPicker";
import { SessionIdentity } from "./primitives";

/** 属性面板一行只有一个 session，超过这个数就折叠 —— 面板放不下更多。 */
const VISIBLE_ROWS = 3;

/** Radix Select 不收空字符串做值，「不指认 agent」得有个自己的键。 */
const NO_AGENT = "__none__";

/**
 * 参与的 session (MUL-591)：对这张卡写过东西的终端会话，一行一个。
 *
 * 行上认的是 agent 而不是「终端类型」：身份在系统里已经有实体，另存一个
 * Claude / Codex / ZCode 的字符串会造出第二套跟 Opened by / Driving 对不上的
 * 身份词汇。写请求本来就带着 agent 身份，自动登记直接把它记下。
 *
 * 自动登记看不见的那部分参与靠下面的表单补：某个会话只在别处讨论过这张卡，
 * 卡上没留下写入，机器无从知道。补出来的行标 manual，读的人有权分辨
 * 「机器看见的」和「人说的」。
 */
export function ParticipantSessions({
  issueId,
  agents,
  agentById,
}: {
  issueId: string;
  /** 补录下拉列的是在岗 agent；已终止的不再是可选身份。 */
  agents: Agent[];
  /** 渲染历史行用的映射，含已终止 agent —— 参与是发生过的事实。 */
  agentById: Map<string, Agent>;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftAgentId, setDraftAgentId] = useState<string>(NO_AGENT);

  const { data: sessions } = useQuery({
    queryKey: queryKeys.issues.participantSessions(issueId),
    queryFn: () => issuesApi.listParticipantSessions(issueId),
  });

  const refresh = () => queryClient.invalidateQueries({
    queryKey: queryKeys.issues.participantSessions(issueId),
  });

  const add = useMutation({
    mutationFn: (input: { sessionId: string; agentId: string | null }) =>
      issuesApi.addParticipantSession(issueId, input),
    onSuccess: () => { setDraft(""); setDraftAgentId(NO_AGENT); void refresh(); },
  });
  const remove = useMutation({
    mutationFn: (sessionId: string) => issuesApi.removeParticipantSession(issueId, sessionId),
    onSuccess: () => { void refresh(); },
  });

  const rows = sessions ?? [];
  const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS);
  const hidden = rows.length - shown.length;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {rows.length === 0 ? (
        <span className="text-sm text-muted-foreground">还没有 session 在这张卡上写过东西</span>
      ) : (
        shown.map((row) => {
          const agent = row.agentId ? agentById.get(row.agentId) ?? null : null;
          return (
            <div key={row.sessionId} className="flex min-w-0 items-center gap-1">
              <SessionIdentity
                agentId={row.agentId}
                agentName={agent?.name ?? null}
                agentIcon={agent?.icon ?? null}
                agentCustomIconUrl={agent ? agentCustomIcon(agent) : null}
                agentAdapterType={agent?.adapterType ?? null}
                userId={null}
                sessionId={row.sessionId}
                shortSessionId
                unattributedLabel="未知"
                tag={row.source === "manual" ? "手动" : undefined}
              />
              <button
                type="button"
                onClick={() => remove.mutate(row.sessionId)}
                disabled={remove.isPending}
                title="从参与列表移除"
                aria-label={`移除 ${row.sessionId}`}
                className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="cursor-pointer self-start text-(length:--text-micro) text-muted-foreground hover:text-foreground"
        >
          还有 {hidden} 个
        </button>
      )}
      {expanded && rows.length > VISIBLE_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="cursor-pointer self-start text-(length:--text-micro) text-muted-foreground hover:text-foreground"
        >
          收起
        </button>
      )}
      <form
        className="flex flex-col gap-1 pt-0.5"
        onSubmit={(event) => {
          event.preventDefault();
          const sessionId = draft.trim();
          if (sessionId) add.mutate({ sessionId, agentId: draftAgentId === NO_AGENT ? null : draftAgentId });
        }}
      >
        <Select value={draftAgentId} onValueChange={setDraftAgentId}>
          <SelectTrigger className="h-6 w-full text-(length:--text-micro)" aria-label="补录的 agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_AGENT}>不指认 agent</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="补一个 session id"
            className="h-6 min-w-0 flex-1 font-mono text-(length:--text-micro)"
          />
          <Button type="submit" size="sm" variant="ghost" className="h-6 px-2" disabled={!draft.trim() || add.isPending}>
            添加
          </Button>
        </div>
      </form>
    </div>
  );
}
