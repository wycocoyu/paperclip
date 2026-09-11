import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { decisions, documents, issueDocuments, issueWorkProducts } from "@paperclipai/db";
import {
  FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN,
  FEISHU_ISSUE_WIKI_URL_PREFIX,
  isFeishuIssueWikiDoc,
  isSettledDecisionLogEntry,
  parseDecisionLogEntries,
} from "@paperclipai/shared";

/**
 * The close-out prerequisite check (MUL-137, 老板令 2026-08-28).
 *
 * 一个 issue 必须起码有需求设计、技术方案，以及决策依据。需求设计与技术方案
 * 二选一（MUL-603，老板令 2026-09-11）：卡内 requirements + tech-proposal 两份
 * 文档，或卡上挂着飞书知识库「需求 issue 区」固定页下的本卡子目录链接。决策依据二选一
 * （MUL-465 放宽，老板令 2026-09-01）：decision-log 文档至少一条「已定」条目，
 * 或一张 decided 状态的关联决策卡——决策卡降级后，亲审场景只记 decision-log，
 * 不再强制开卡。That rule started as the MUL-37 convention (documents keyed
 * requirements / tech-proposal / spec plus a thin body); this check is the
 * enforcement half, consulted when a card tries to enter in_review or done.
 *
 * The decision linkage itself is already welded at the schema level
 * (`decisions.originIssueId` is a NOT NULL FK); here we additionally require
 * status "decided" so a draft decision no longer satisfies the gate by itself.
 *
 * Missing pieces are returned as lines that each name the fix, so the 422
 * tells the caller exactly what to put where instead of a bare "not allowed".
 */
/**
 * test-baseline / test-result 的结构化失败清单（MUL-558 基线对比门）。
 * 约定两份文档同构：JSON {"command": string, "failures": string[]}。
 * 解析不了返回 null——按「结构不对」拦下并提示重写，不做容错猜测。
 */
function parseTestFailures(body: string | null | undefined): string[] | null {
  if (body == null) return null;
  try {
    const parsed = JSON.parse(body) as { failures?: unknown };
    if (!Array.isArray(parsed?.failures)) return null;
    return parsed.failures.map((f) => String(f));
  } catch {
    return null;
  }
}

export async function missingIssueClosePrerequisites(
  db: Pick<Db, "select">,
  companyId: string,
  issue: { id: string; description: string | null; workingBranch?: string | null },
): Promise<string[]> {
  const missing: string[] = [];

  if (!(issue.description ?? "").trim()) {
    missing.push("正文（description）为空——issue update <卡> --description \"> 一句话摘要…\"，厚内容走文档");
  }

  const docRows = await db
    .select({ key: issueDocuments.key, body: documents.latestBody })
    .from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(and(
      eq(issueDocuments.companyId, companyId),
      eq(issueDocuments.issueId, issue.id),
      inArray(issueDocuments.key, ["requirements", "tech-proposal", "decision-log", "test-baseline", "test-result"]),
    ));
  const keys = new Set(docRows.map((row) => row.key));

  // MUL-603：需求设计与技术方案搬去了飞书知识库。走 wiki 通路时正文在飞书，
  // 服务端读不到，验证证据改由 CLI 在 work-product:create 那一刻校验
  // （见 cli/src/commands/client/feishu-wiki-check.ts）。
  //
  // 规则上新卡只有 wiki 一条路（老板令 2026-09-11），这里仍然放行卡内两份文档
  // 是给存量卡留的：改判据那天有 191 张非终态卡一条 wiki 链接都没有，硬切会让
  // 它们全部收不了卡，而「迭代只改机制，存量不补」是既定规则。
  // 删除条件（别让它变成忘掉的「以后再删」）：in_progress 与 in_review 的卡
  // 全部挂上合规 wiki 链接时，把下面的 keys.has(...) 那一支删掉。backlog 不计。
  const wikiRows = await db
    .select({ type: issueWorkProducts.type, url: issueWorkProducts.url, metadata: issueWorkProducts.metadata })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issueWorkProducts.issueId, issue.id),
      eq(issueWorkProducts.type, "document"),
    ));
  const hasWikiDoc = wikiRows.some(isFeishuIssueWikiDoc);

  if (!hasWikiDoc && !(keys.has("requirements") && keys.has("tech-proposal"))) {
    if (!keys.has("requirements")) {
      missing.push("缺「需求设计」文档——issue document:put <卡> requirements --body-file 需求设计.md");
    }
    if (!keys.has("tech-proposal")) {
      missing.push("缺「技术方案」文档——issue document:put <卡> tech-proposal --body-file 方案.md");
    }
    missing.push(`——或走飞书知识库通路：在「需求 issue 区」下建本卡子目录（含「技术方案」子页，正文须有「验证」字样与命令/输出代码块），再把子目录链接挂上：issue work-product:create <卡> --payload-json '{"type":"document","provider":"custom","title":"<卡号> 需求与方案","url":"${FEISHU_ISSUE_WIKI_URL_PREFIX}<node_token>","metadata":{"parentNodeToken":"${FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN}"}}'`);
  }

  // 门禁 A（MUL-558）：代码卡的验证证据——只判在不在，不判真假。
  // 代码卡 = 登记过工作分支（issue start 落 workingBranch）；纯调研/文字卡不检查。
  // 走 wiki 通路的卡不在这里判：正文不在库里，这一半挪去了 CLI 创建校验。
  const techProposalBody = docRows.find((row) => row.key === "tech-proposal")?.body ?? "";
  if (!hasWikiDoc && issue.workingBranch && keys.has("tech-proposal")) {
    const hasCommandBlock = techProposalBody.includes("```");
    const mentionsVerification = /验证|verification/i.test(techProposalBody);
    if (!hasCommandBlock || !mentionsVerification) {
      missing.push("代码卡（已登记分支）的 tech-proposal 缺验证证据——正文须含「验证」字样与至少一个命令/输出代码块（只判在不在，不判真假）——issue document:put <卡> tech-proposal --body-file 方案.md 补「验证方式」节并贴命令输出");
    }
  }

  // 门禁 B（MUL-558）：基线对比，opt-in。开工时写了 test-baseline 才启用：
  // 收卡须有同构 test-result，且新增失败（result − baseline）为空——拿掉
  // 「这是历史问题」的解释权。没写 baseline 的卡不受限（快车道）。
  const baselineBody = docRows.find((row) => row.key === "test-baseline")?.body;
  if (baselineBody != null) {
    const resultBody = docRows.find((row) => row.key === "test-result")?.body;
    if (resultBody == null) {
      missing.push("这张卡开工时登记了 test-baseline，收卡须有同构 test-result 对照——issue document:put <卡> test-result --body-file 结果.json（内容 {\"command\":\"…\",\"failures\":[…]}）");
    } else {
      const baseline = parseTestFailures(baselineBody);
      const result = parseTestFailures(resultBody);
      if (!baseline || !result) {
        missing.push("test-baseline / test-result 须为 JSON {\"command\",\"failures\":[…]}——现在至少一份解析不了，document:put 重写为结构化 JSON 再收卡");
      } else {
        const baselineSet = new Set(baseline);
        const newFailures = result.filter((f) => !baselineSet.has(f));
        if (newFailures.length > 0) {
          missing.push(`基线对比：${newFailures.length} 个新增失败（结果有、基线无）——${newFailures.slice(0, 3).join("；")}${newFailures.length > 3 ? " 等" : ""}。修掉再收，或确属既有问题则开工时重登基线：issue document:put <卡> test-baseline`);
        }
      }
    }
  }

  const decisionLogBody = docRows.find((row) => row.key === "decision-log")?.body ?? "";
  const [decision] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(
      eq(decisions.companyId, companyId),
      eq(decisions.originIssueId, issue.id),
      eq(decisions.status, "decided"),
    ))
    .limit(1);
  // 决策卡已停用（老板 2026-09-03）：提示只引导 decision-log；查询仍认存量 decided 卡，免得在途老卡被卡住
  if (!decision && !parseDecisionLogEntries(decisionLogBody).some(isSettledDecisionLogEntry)) {
    missing.push("缺决策依据——decision-log 至少一条「已定」条目（issue document:get <卡> decision-log 给骨架，填完 document:put）");
  }

  return missing;
}

/**
 * 门禁前置可发现 (MUL-448, 老板令 2026-08-31).
 *
 * The gates along 建卡→认领→开工→干活→收尾 all answer at write time: an agent
 * finishes a whole card, pushes in_review, and only then learns it is missing
 * three documents. The judgement above was already pure and read-only — this
 * is the read side of the same rules, so `issue claim` can print the card's
 * whole debt when it is taken rather than when it is closed.
 *
 * Deliberately NOT a guarantee. It covers the four gates whose conditions are
 * knowable from the card plus the caller's identity (收卡门禁 MUL-137,
 * 认领门禁 MUL-72, 裁决模式 MUL-131, 交接门禁 invalid_issue_disposition).
 * Revision conflicts and decision body validation stay write-time only because
 * their inputs do not exist until the write is attempted; `coverage` says so in
 * the payload so an empty `blocking` is never read as "nothing can stop me".
 *
 * The 交接门禁 verdict is computed by the caller rather than here: its five
 * accepted paths need the interaction and approval services, which live in the
 * route. Passing the boolean in keeps this module db-only and, more
 * importantly, keeps the write-time gate and this read the same judgement —
 * both call the route's hasInReviewReviewPath.
 */
/**
 * 卡内术语的状态 (MUL-494)：这张卡有没有 `glossary`、里面几条。
 *
 * 只报事实，不判断「这卡该不该有」——那要看它有没有造新词，机器判不了。当天
 * 6 张新卡只有 1 张真有新词，硬报「你该写」会让另外 5 张留空段或硬凑，把一个
 * 思考动作变成填空。词条按 `_别用_` 行计数：每条词条恰好一行，比数加粗标记稳。
 */
async function readGlossaryState(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
): Promise<{ exists: boolean; termCount: number }> {
  const [row] = await db
    .select({ body: documents.latestBody })
    .from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(and(
      eq(issueDocuments.companyId, companyId),
      eq(issueDocuments.issueId, issueId),
      eq(issueDocuments.key, "glossary"),
    ))
    .limit(1);
  if (!row) return { exists: false, termCount: 0 };
  const termCount = (row.body ?? "").split("\n").filter((line) => line.startsWith("_别用_")).length;
  return { exists: true, termCount };
}

export type IssuePreflightActor =
  | { type: "agent"; agentId: string | null }
  | { type: "board" }
  | { type: "other" };

export type IssuePreflightBlocker = {
  gate: string;
  code: string;
  detail: string[];
  fix: string;
};

export type IssuePreflight = {
  issueId: string;
  status: string | null;
  /** Every gate that would reject this caller's next write. */
  blocking: IssuePreflightBlocker[];
  closeGate: { ready: boolean; missing: string[] };
  claimGate: {
    claimed: boolean;
    assigneeAgentId: string | null;
    drivingAgentId: string | null;
    blocksThisActor: boolean;
  };
  adjudicationGate: { mode: string; canSelfClose: boolean };
  reviewPathGate: { ready: boolean; blocksThisActor: boolean };
  /**
   * 开工登记 (MUL-465)：not a gate — nothing rejects a card for missing it.
   * It rides along because "开工前把讨论提炼成决策卡" has no moment to fire
   * when `issue start` never ran, so the answer to "why is the card always
   * short a decision at close time" is usually here.
   */
  startGate: { started: boolean; workingBranch: string | null };
  /**
   * 卡内术语 (MUL-494)：同样 not a gate。这张卡有没有 `glossary`、里面几条，
   * 只报事实不做判断——「这卡该不该有术语表」要看它有没有造新词，那是机器
   * 判不了的，硬报「你该写」会把一个思考动作变成填空。
   */
  glossaryGate: { exists: boolean; termCount: number };
  coverage: string;
};

export async function issuePreflight(
  db: Pick<Db, "select">,
  issue: {
    id: string;
    companyId: string;
    description: string | null;
    status: string | null;
    assigneeAgentId: string | null;
    drivingAgentId: string | null;
    workingBranch?: string | null;
  },
  actor: IssuePreflightActor,
  adjudicationMode: string,
  /** Whether the card already hands the next action to someone — see the route's hasInReviewReviewPath. */
  hasReviewPath: boolean,
): Promise<IssuePreflight> {
  const missing = await missingIssueClosePrerequisites(db, issue.companyId, issue);
  const glossaryState = await readGlossaryState(db, issue.companyId, issue.id);
  const claimed = issue.assigneeAgentId != null || issue.drivingAgentId != null;
  // Both agent-only gates exempt board callers, so every answer here is about
  // this caller rather than about the card in the abstract.
  const isAgent = actor.type === "agent";
  const claimBlocks = isAgent && !claimed;
  const canSelfClose = !isAgent || adjudicationMode !== "manual";

  const blocking: IssuePreflightBlocker[] = [];
  if (claimBlocks) {
    blocking.push({
      gate: "认领门禁",
      code: "issue_unclaimed",
      detail: ["这张卡没有 assignee 也没有 Driving，你写进度或推状态会被 409 挡回"],
      fix: `paperclipai issue claim ${issue.id}`,
    });
  }
  if (missing.length > 0) {
    blocking.push({
      gate: "收卡门禁",
      code: "issue_prerequisites_missing",
      detail: missing,
      fix: "按每行末尾的命令逐样补齐，再推 in_review",
    });
  }
  if (!canSelfClose) {
    blocking.push({
      gate: "裁决模式",
      code: "manual_adjudication_required",
      detail: ["当前是亲审模式，收卡的裁决权在人，你自己置 done 会被 422 挡回"],
      fix: `paperclipai issue update ${issue.id} --assignee-user-id local-board --status in_review，然后等老板在收件箱 Approve`,
    });
  }
  // 交接门禁: an agent may not park a card in in_review with nobody owning the
  // next action. Already in_review cards are past it, so only a card still to
  // be pushed can be blocked by it.
  const reviewPathBlocks = isAgent && !hasReviewPath && issue.status !== "in_review";
  if (reviewPathBlocks) {
    blocking.push({
      gate: "交接门禁",
      code: "invalid_issue_disposition",
      detail: ["这张卡没有人也没有机制接下一步动作，推 in_review 会被 422 挡回"],
      fix: `认领它就行，接卡人算自己的验收人（MUL-451）：paperclipai issue claim ${issue.id}`,
    });
  }

  return {
    issueId: issue.id,
    status: issue.status,
    blocking,
    closeGate: { ready: missing.length === 0, missing },
    claimGate: {
      claimed,
      assigneeAgentId: issue.assigneeAgentId,
      drivingAgentId: issue.drivingAgentId,
      blocksThisActor: claimBlocks,
    },
    adjudicationGate: { mode: adjudicationMode, canSelfClose },
    reviewPathGate: { ready: hasReviewPath, blocksThisActor: reviewPathBlocks },
    startGate: { started: issue.workingBranch != null, workingBranch: issue.workingBranch ?? null },
    glossaryGate: glossaryState,
    coverage:
      "只覆盖收卡门禁（含 MUL-558 两道子检查：代码卡验证证据、基线对比，同样随收卡清单报出）、认领门禁、裁决模式、交接门禁四道。开工登记不是门禁，只随报。文档修订冲突、正文防旧覆盖、决策三段校验等要到写入那一刻才判得出来，blocking 为空不等于一定写得进去。",
  };
}
