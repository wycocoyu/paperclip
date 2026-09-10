import { History } from "lucide-react";
import { parseDecisionLogEntries } from "@paperclipai/shared";

import { InlineBanner } from "@/components/InlineBanner";
import { useIssueDocuments } from "@/hooks/useIssueDocuments";

export interface IssueDoneNoticeProps {
  issueStatus?: string | null;
  issueId?: string | null;
}

/** 收卡时留下的四样材料，按读的人最可能先翻的顺序。 */
const MATERIAL_KEYS = [
  { key: "requirements", label: "需求底稿" },
  { key: "tech-proposal", label: "技术方案" },
  { key: "spec", label: "实现 Spec" },
  { key: "decision-log", label: "决策过程" },
] as const;

/**
 * done = 过去时（MUL-490）：卡收了之后不再跟着现实改，所以正文和文档里写的是当时
 * 的事实。读的人要在读之前知道这一点，否则会把过期内容当成现状 —— 实测发生过两次
 * （MUL-466 正文、MUL-476 decision-log）。
 *
 * 附一行材料索引，是为了让人打开一张老卡就知道该翻哪份文档。它**不是门禁状态**：
 * 收卡门禁只做检查然后放行，不存结果（issues.ts 的 missingIssueClosePrerequisites
 * 调完即丢），"当时怎么过门的"这份数据不存在；而实时重查会把收卡后被删的文档报成
 * 不通过，让人误以为当年是硬推进去的。所以这里只报"现在还留着哪几样"。
 */
export function IssueDoneNotice({ issueStatus, issueId }: IssueDoneNoticeProps) {
  const isDone = issueStatus === "done";
  const { data: documents } = useIssueDocuments(isDone ? issueId : null);

  if (!isDone) return null;

  // decision-log 数条目、不数文档在不在 (MUL-590)：开卡会播种一份骨架，文档从此每张卡
  // 都有，按存在性报就等于每张收了的卡都声称留下了决策过程。骨架里那条示例的日期写的是
  // `YYYY-MM-DD`，解析不出条目，所以一条没填的卡自然落在门外。
  const kept = MATERIAL_KEYS.filter((m) => {
    const doc = (documents ?? []).find((d) => d.key === m.key);
    if (!doc) return false;
    if (m.key !== "decision-log") return true;
    return parseDecisionLogEntries(doc.body ?? "").length > 0;
  });

  return (
    <InlineBanner tone="info" compact icon={History} title="本 issue 为过去时">
      这张卡已经收了。里面写的是当时的事实、现在可能已经不成立、一切以当前为准。发现过期也不用回头改它。
      {documents ? (
        <div className="mt-1 text-xs opacity-80">
          {kept.length > 0 ? `留下的材料：${kept.map((m) => m.label).join("、")}` : "除正文外没有留下其他文档。"}
        </div>
      ) : null}
    </InlineBanner>
  );
}
