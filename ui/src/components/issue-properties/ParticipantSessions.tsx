import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SessionIdentity } from "./primitives";

/** 属性面板一行只有一个 session，超过这个数就折叠 —— 面板放不下更多。 */
const VISIBLE_ROWS = 3;

/**
 * 参与的 session (MUL-591)：对这张卡写过东西的终端会话，一行一个 id。
 *
 * 自动登记看不见的那部分参与靠输入框补：某个会话只在别处讨论过这张卡，
 * 卡上没留下写入，机器无从知道。补出来的行标 manual，读的人有权分辨
 * 「机器看见的」和「人说的」。
 */
export function ParticipantSessions({ issueId }: { issueId: string }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");

  const { data: sessions } = useQuery({
    queryKey: queryKeys.issues.participantSessions(issueId),
    queryFn: () => issuesApi.listParticipantSessions(issueId),
  });

  const refresh = () => queryClient.invalidateQueries({
    queryKey: queryKeys.issues.participantSessions(issueId),
  });

  const add = useMutation({
    mutationFn: (sessionId: string) => issuesApi.addParticipantSession(issueId, sessionId),
    onSuccess: () => { setDraft(""); void refresh(); },
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
        shown.map((row) => (
          <div key={row.sessionId} className="flex min-w-0 items-center gap-1">
            <SessionIdentity
              agentId={null}
              agentName={null}
              userId={null}
              sessionId={row.sessionId}
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
        ))
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
        className="flex items-center gap-1 pt-0.5"
        onSubmit={(event) => {
          event.preventDefault();
          const sessionId = draft.trim();
          if (sessionId) add.mutate(sessionId);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="补一个 session id"
          className="h-6 min-w-0 flex-1 font-mono text-(length:--text-micro)"
        />
        <Button type="submit" size="sm" variant="ghost" className="h-6 px-2" disabled={!draft.trim() || add.isPending}>
          添加
        </Button>
      </form>
    </div>
  );
}
