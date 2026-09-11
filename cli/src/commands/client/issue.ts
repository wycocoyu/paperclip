import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { ApiRequestError } from "../../client/http.js";
import {
  addIssueCommentSchema,
  acceptIssueThreadInteractionSchema,
  buildSettledDecisionsSnapshot,
  renderSettledDecisionsDocument,
  cancelIssueThreadInteractionSchema,
  checkoutIssueSchema,
  createChildIssueSchema,
  createIssueLabelSchema,
  createIssueSchema,
  createIssueThreadInteractionSchema,
  createIssueTreeHoldSchema,
  createIssueWorkProductSchema,
  decisionLogTemplateError,
  type FeedbackTrace,
  type HeartbeatRun,
  linkIssueApprovalSchema,
  previewIssueTreeControlSchema,
  rejectIssueThreadInteractionSchema,
  releaseIssueTreeHoldSchema,
  respondIssueThreadInteractionSchema,
  resolveIssueRecoveryActionSchema,
  restoreIssueDocumentRevisionSchema,
  updateIssueSchema,
  updateIssueWorkProductSchema,
  type Issue,
  type IssueComment,
  type Project,
  upsertIssueDocumentSchema,
  upsertIssueFeedbackVoteSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  inferContentTypeFromPath,
  printOutput,
  resolveCommandContext,
  resolveSessionId,
  resolveSessionIdVerbose,
  detectTerminalSlug,
  autoClaimIfUnclaimed,
  type BaseClientOptions,
  type ResolvedClientContext,
  assertDecisionBodyTemplate,
  defaultDocumentTitle,
  documentSkeleton,
  findUnwrittenOverturns,
  isSettledDecisionLogEntry,
  parseDecisionLogEntries,
} from "./common.js";
import { sessionLocatorForSlug } from "@paperclipai/shared/session-locator";
import { displayModelName } from "@paperclipai/shared/model-signature";
import { readLocalModelSignature } from "./local-model.js";
import { assertFeishuIssueWikiWorkProduct } from "./feishu-wiki-check.js";
import {
  buildFeedbackTraceQuery,
  normalizeFeedbackTraceExportFormat,
  serializeFeedbackTraces,
} from "./feedback.js";

interface IssueBaseOptions extends BaseClientOptions {
  status?: string;
  assigneeAgentId?: string;
  projectId?: string;
  match?: string;
}

interface IssueCreateOptions extends BaseClientOptions {
  title: string;
  description: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  project?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  requestDepth?: string;
  billingCode?: string;
  session?: string;
  allowDuplicate?: boolean;
  asBoard?: boolean;
}

interface IssueUpdateOptions extends BaseClientOptions {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  requestDepth?: string;
  billingCode?: string;
  comment?: string;
  hiddenAt?: string;
  reviewerSession?: string;
  reviewerAgent?: string;
}

interface IssueClaimOptions extends BaseClientOptions {
  note?: string;
  status?: string;
  force?: boolean;
}

interface IssueStartOptions extends BaseClientOptions {
  branch: string;
  worktree?: string;
  base?: string;
  dependsOn?: string;
  note?: string;
  session?: string;
  force?: boolean;
}

interface IssueProgressOptions extends BaseClientOptions {
  tone?: string;
}

interface IssueCommentOptions extends BaseClientOptions {
  body: string;
  reopen?: boolean;
  resume?: boolean;
}

interface IssueCommentListOptions extends BaseClientOptions {
  afterCommentId?: string;
  order?: string;
  limit?: string;
}

interface IssueCheckoutOptions extends BaseClientOptions {
  agentId: string;
  expectedStatuses?: string;
}

interface IssueFeedbackOptions extends BaseClientOptions {
  targetType?: string;
  vote?: string;
  status?: string;
  from?: string;
  to?: string;
  sharedOnly?: boolean;
  includePayload?: boolean;
  out?: string;
  format?: string;
}

interface IssueArchiveOptions extends BaseClientOptions {
  yes?: boolean;
  reason?: string;
}

interface JsonPayloadOptions extends BaseClientOptions {
  payloadJson: string;
}

interface IssueDocumentPutOptions extends BaseClientOptions {
  title?: string;
  format?: string;
  body?: string;
  bodyFile?: string;
  changeSummary?: string;
  baseRevisionId?: string;
}

interface IssueDocumentRevisionsOptions extends BaseClientOptions {
  rev?: string;
}

interface IssueDocumentImageOptions extends BaseClientOptions {
  companyId?: string;
  file: string;
  caption?: string;
  title?: string;
  changeSummary?: string;
}

interface IssueAttachmentUploadOptions extends BaseClientOptions {
  companyId?: string;
  file: string;
  commentId?: string;
}

interface IssueAttachmentDownloadOptions extends BaseClientOptions {
  out?: string;
}

interface IssueLabelCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  color: string;
}

interface IssueRecoveryResolveOptions extends BaseClientOptions {
  actionId?: string;
  outcome: string;
  sourceIssueStatus: string;
  resolutionNote?: string;
}

interface InteractionAcceptOptions extends BaseClientOptions {
  selectedClientKeys?: string;
  selectedOptionIds?: string;
}

interface InteractionReasonOptions extends BaseClientOptions {
  reason?: string;
}

interface InteractionRespondOptions extends BaseClientOptions {
  answersJson: string;
  summaryMarkdown?: string;
}

interface TreeHoldListOptions extends BaseClientOptions {
  status?: string;
  mode?: string;
  includeMembers?: boolean;
}

/**
 * A name is not an identity: agents get renamed and the same seat is Codex
 * today and something else tomorrow, so a `--*-agent` flag is resolved to a
 * real agent id before it is stored. The directory is fetched once per command.
 */
function agentIdResolver(ctx: ResolvedClientContext, companyId: string | undefined) {
  let directory: Array<{ id: string; name: string; urlKey?: string }> | null = null;
  return async (ref: string | null, flag: string): Promise<string | null> => {
    if (!ref) return null;
    if (!directory) {
      if (!companyId) throw new Error(`cannot resolve ${flag} without a company; pass -C`);
      directory = (await ctx.api.get<Array<{ id: string; name: string; urlKey?: string }>>(
        apiPath`/api/companies/${companyId}/agents`,
      )) ?? [];
    }
    const needle = ref.trim();
    const match = directory.find((a) => a.id === needle)
      ?? directory.find((a) => a.name === needle)
      ?? directory.find((a) => a.urlKey === needle)
      ?? directory.find((a) => a.name.toLowerCase() === needle.toLowerCase());
    if (!match) {
      process.stderr.write(`warning: no agent matched "${needle}" for ${flag} — that identity will be missing\n`);
    }
    return match?.id ?? null;
  };
}

/** `--option "id|Label"` — the pipe keeps the flag typable without shell-quoting JSON. */

/**
 * The settled statuses, same set the server uses everywhere else
 * (`BLOCKED_INBOX_TERMINAL_STATUSES` and friends in services/issues.ts).
 * `in_review` and `blocked` are deliberately not here: claiming out of review
 * and unblocking are both normal forward moves.
 */
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

/**
 * 终态卡写保护 (MUL-555).
 *
 * `claim` and `start` both PATCH status to in_progress unconditionally. On a
 * finished card that silently rewrites a settled outcome, and the status flip
 * plus the Driving overwrite are not undoable — so this refuses before the
 * first write instead of reporting after it. Team Rules said the same thing in
 * prose ("对已 done 的卡不要补 claim"); prose is what a reader can skip.
 *
 * Reopening stays possible and stays deliberate: it is spelled differently
 * (`issue update --status todo`), and `--force` is here for the case where
 * pushing the status really is what the caller means.
 */
function assertNotTerminalForWrite(
  issue: { id: string; identifier?: string | null; title?: string | null; status?: string | null },
  command: "claim" | "start",
  force: boolean | undefined,
): void {
  if (force) return;
  const status = issue.status ?? "";
  if (!TERMINAL_ISSUE_STATUSES.has(status)) return;
  const ref = issue.identifier ?? issue.id;
  throw new Error(
    [
      `issue_invalid_state_transition：${ref}「${issue.title ?? "(无标题)"}」已是 ${status}，${command} 会把它强推回 in_progress。`,
      `  · 这一步不可逆：状态与 Driving 都会被覆盖，卡上留下改过的痕迹`,
      `  · 要重开这张卡：paperclipai issue update ${ref} --status todo，然后再 claim`,
      `  · 确实就是要强推：同样的命令加 --force`,
    ].join("\n"),
  );
}

/** Shape of `GET /api/issues/:id/preflight` (MUL-448). */
type IssuePreflightReport = {
  issueId: string;
  status: string | null;
  blocking: Array<{ gate: string; code: string; detail: string[]; fix: string }>;
  closeGate: { ready: boolean; missing: string[] };
  claimGate: { claimed: boolean; blocksThisActor: boolean };
  adjudicationGate: { mode: string; canSelfClose: boolean };
  reviewPathGate: { ready: boolean; blocksThisActor: boolean };
  startGate?: { started: boolean; workingBranch: string | null };
  coverage: string;
};

/**
 * Human rendering of a preflight report. The point of the command is that a
 * reader takes it in at a glance and knows what to do next, so blockers lead
 * and each one carries its own fix line; the coverage caveat always prints,
 * including on a clean card, so "没有拦你的" is never mistaken for a promise.
 */
function formatPreflight(report: IssuePreflightReport): string {
  const lines: string[] = [];
  if (report.blocking.length === 0) {
    lines.push("四道门禁都不拦你。");
  } else {
    lines.push(`${report.blocking.length} 道门禁会拦住你：`);
    for (const blocker of report.blocking) {
      lines.push("");
      lines.push(`【${blocker.gate}】${blocker.code}`);
      for (const line of blocker.detail) lines.push(`  · ${line}`);
      lines.push(`  修法：${blocker.fix}`);
    }
  }
  lines.push("");
  const start = report.startGate
    ? report.startGate.started
      ? `已登记 ${report.startGate.workingBranch}`
      : "未登记（issue start 没跑）"
    : "未知";
  lines.push(`认领：${report.claimGate.claimed ? "已认领" : "未认领"}　开工：${start}　收卡三件套：${report.closeGate.ready ? "齐了" : `缺 ${report.closeGate.missing.length} 样`}　下一步有人接：${report.reviewPathGate.ready ? "有" : "没有"}　裁决模式：${report.adjudicationGate.mode}${report.adjudicationGate.canSelfClose ? "（你可自己置 done）" : "（你不能自己置 done）"}`);
  lines.push("");
  lines.push(`覆盖范围：${report.coverage}`);
  return lines.join("\n");
}

/**
 * Model and effort for the question side of a QA archive (MUL-444).
 *
 * The asker is whichever terminal is running this command, so its own harness
 * already recorded both facts — an explicit flag still wins, for the case where
 * the archive is filed on someone else's behalf. When the read comes up empty
 * the reason goes to stderr and the fields stay blank: the bubble showing no
 * model is a visible gap, while a guessed one would read as fact.
 */
async function resolveQuestionModelSide(
  explicitModel?: string,
  explicitEffort?: string,
): Promise<{ model: string | null; effort: string | null }> {
  if (explicitModel?.trim() && explicitEffort?.trim()) {
    return { model: explicitModel.trim(), effort: explicitEffort.trim() };
  }
  let slug: string | null = null;
  try {
    slug = detectTerminalSlug();
  } catch {
    slug = null;
  }
  const { sessionId } = resolveSessionId();
  const reading = await readLocalModelSignature(slug, sessionId, process.cwd());
  if (reading.reason) console.error(`question model not read from this terminal: ${reading.reason}`);
  const model = explicitModel?.trim() || displayModelName(reading.model, sessionLocatorForSlug(slug)?.modelNaming ?? "verbatim");
  const effort = explicitEffort?.trim() || reading.effort;
  return { model: model ?? null, effort: effort ?? null };
}

/**
 * The revision to re-base on when the server refused a document write only
 * because no `baseRevisionId` was named (MUL-453).
 *
 * Returns null for every other rejection, including "Document was updated by
 * someone else" — that one carries a currentRevisionId too, but re-basing onto
 * it would silently discard whatever the other writer just saved.
 */
function missingBaseRevisionId(err: unknown): string | null {
  if (!(err instanceof ApiRequestError) || err.status !== 409) return null;
  if (!err.message.includes("requires baseRevisionId")) return null;
  const current = (err.details as { currentRevisionId?: unknown } | null)?.currentRevisionId;
  return typeof current === "string" && current.trim() ? current : null;
}

/**
 * done = 过去时（MUL-490）：读卡的人和 agent 该在读到的那一刻就知道内容可能过期，
 * 而不是自己去翻 status —— 实测 `issue get` 的 `status: "done"` 埋在 JSON 第 10 行，
 * `document:get` 的输出连状态都不带。
 *
 * 形状跟 `decisions:pull` 的警告一致：非 JSON 模式走 stderr，JSON 模式一个字不加，
 * stdout 只放数据。
 */
function noteDoneIsPast(status: unknown, json: boolean): void {
  if (json || status !== "done") return;
  console.error(
    "⚠ 这张卡已经 done 了。里面写的是当时的事实，现在可能已经不成立，一切以当前为准；发现过期也不用回头改它。\n",
  );
}

/** document 自己不带卡的状态，只能回头取一次 issue。取不到就不提示，读文档本身不受影响。 */
interface IssueDocumentRevision {
  id: string;
  revisionNumber: number;
  title: string | null;
  format: string;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

/** 作者列表里的 agent id 换成名字；查不到就让调用方回落到 id，不因此让整条命令失败。 */
async function resolveRevisionAuthorNames(
  ctx: ResolvedClientContext,
  revisions: IssueDocumentRevision[],
): Promise<Map<string, string>> {
  const ids = [...new Set(revisions.map((rev) => rev.createdByAgentId).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const agent = await ctx.api.get<{ name?: string }>(apiPath`/api/agents/${id}`).catch(() => null);
      if (agent?.name) names.set(id, agent.name);
    }),
  );
  return names;
}

async function noteDoneIsPastForIssue(ctx: ResolvedClientContext, issueId: string): Promise<void> {
  if (ctx.json) return;
  const issue = await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`).catch(() => null);
  noteDoneIsPast(issue?.status, false);
}

export function registerIssueCommands(program: Command): void {
  const issue = program.command("issue").description("Issue operations");

  addCommonClientOptions(
    issue
      .command("list")
      .description("List issues for a company")
      .option("-C, --company-id <id>", "Company ID")
      .option("--status <csv>", "Comma-separated statuses")
      .option("--assignee-agent-id <id>", "Filter by assignee agent ID")
      .option("--project-id <id>", "Filter by project ID")
      .option("--match <text>", "Local text match on identifier/title/description")
      .action(async (opts: IssueBaseOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.assigneeAgentId) params.set("assigneeAgentId", opts.assigneeAgentId);
          if (opts.projectId) params.set("projectId", opts.projectId);

          const query = params.toString();
          const path = `${apiPath`/api/companies/${ctx.companyId}/issues`}${query ? `?${query}` : ""}`;
          const rows = (await ctx.api.get<Issue[]>(path)) ?? [];

          const filtered = filterIssueRows(rows, opts.match);
          if (ctx.json) {
            printOutput(filtered, { json: true });
            return;
          }

          if (filtered.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const item of filtered) {
            console.log(
              formatInlineRecord({
                identifier: item.identifier,
                id: item.id,
                status: item.status,
                priority: item.priority,
                assigneeAgentId: item.assigneeAgentId,
                title: item.title,
                projectId: item.projectId,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("get")
      .description("Get an issue by UUID or identifier (e.g. PC-12)")
      .argument("<idOrIdentifier>", "Issue ID or identifier")
      .action(async (idOrIdentifier: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Issue>(apiPath`/api/issues/${idOrIdentifier}`);
          noteDoneIsPast(row?.status, ctx.json);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // Issues are archive-only (MUL-109): there is no delete command, because
  // there is no delete. The database refuses it whoever asks.
  addCommonClientOptions(
    issue
      .command("archive")
      .description("Archive an issue (issues cannot be deleted)")
      .argument("<issueId>", "Issue ID")
      .option("--yes", "Confirm archiving")
      .option("--reason <text>", "Why this card is leaving the board")
      .action(async (issueId: string, opts: IssueArchiveOptions) => {
        try {
          if (!opts.yes) throw new Error("Refusing to archive without --yes");
          const ctx = resolveCommandContext(opts);
          const archived = await ctx.api.post<Issue>(
            apiPath`/api/issues/${issueId}/archive`,
            { reason: opts.reason ?? null },
          );
          printOutput(archived, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("unarchive")
      .description("Restore an archived issue to the board")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const restored = await ctx.api.delete<Issue>(apiPath`/api/issues/${issueId}/archive`);
          printOutput(restored, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("heartbeat-context")
      .description("Get heartbeat context for an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const context = await ctx.api.get(apiPath`/api/issues/${issueId}/heartbeat-context`);
          printOutput(context, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("create")
      .description("Create an issue")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--title <title>", "Issue title")
      .requiredOption("--description <text>", "Issue description — required (MUL-137). Open with a one-line `> quote` summary; thick content goes into requirements / tech-proposal documents")
      .option("--status <status>", "Issue status")
      .option("--priority <priority>", "Issue priority")
      .option("--assignee-agent-id <id>", "Assignee agent ID")
      .option(
        "--project <name|id>",
        "Project name, shortname (urlKey), or ID. Required for a top-level issue; a sub-issue inherits its parent's project",
      )
      .option("--project-id <id>", "Project ID (raw UUID; prefer --project)")
      .option("--goal-id <id>", "Goal ID")
      .option("--parent-id <id>", "Parent issue ID")
      .option("--request-depth <n>", "Request depth integer")
      .option("--billing-code <code>", "Billing code")
      .option(
        "--session <id>",
        "Session id to record on the card — which CLI/agent session filed it (navigation aid, not identity). Defaults to whatever this host terminal publishes; Zcode and Qoder publish nothing, so pass it there",
      )
      .option("--allow-duplicate", "Create even when an active issue with the same title exists")
      .option("--as-board", "File as the board instead of an agent — the card gets no agent author and that cannot be corrected later")
      .option("--branch <name>", "Working branch name (optional at creation; use issue start to register it)")
      .action(async (opts: IssueCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (opts.project && opts.projectId) {
            throw new Error("pass either --project or --project-id, not both");
          }
          let projectId = opts.projectId;
          const listProjects = async () =>
            (await ctx.api.get<Project[]>(apiPath`/api/companies/${ctx.companyId}/projects`)) ?? [];
          const describeProjects = (projects: Project[]) =>
            projects.length > 0
              ? projects.map((p) => `${p.name} (${p.urlKey})`).join(", ")
              : "no projects yet — create one with `project create`";
          if (opts.project) {
            const ref = opts.project.trim();
            const projects = await listProjects();
            const hit = projects.find(
              (p) =>
                p.id === ref ||
                p.name.toLowerCase() === ref.toLowerCase() ||
                p.urlKey.toLowerCase() === ref.toLowerCase(),
            );
            if (!hit) {
              throw new Error(`project not found: ${ref}. This company has: ${describeProjects(projects)}`);
            }
            projectId = hit.id;
          } else if (!projectId && opts.parentId) {
            const parent = await ctx.api.get<Issue>(apiPath`/api/issues/${opts.parentId}`);
            projectId = parent?.projectId ?? undefined;
          }
          if (!projectId) {
            const projects = await listProjects();
            throw new Error(
              `project is required: every issue belongs to a project — pass --project <name>. This company has: ${describeProjects(projects)}`,
            );
          }
          // Cards are filed from terminal agents, and authorship is stamped
          // from the authenticated caller at create time — a card opened
          // without an agent key reads as "local-board" and cannot be
          // corrected by the agent afterwards. Fail before writing rather
          // than leave an unattributable card behind. A human filing from
          // their own shell passes --as-board to say so deliberately.
          if (!opts.asBoard) {
            const me = await ctx.api
              .get<{ id: string; name?: string } | null>("/api/agents/me")
              .catch(() => null);
            if (!me?.id) {
              throw new Error(
                "no agent identity — this card would be filed as local-board and the author could not be fixed afterwards.\n"
                + "  set PAPERCLIP_API_KEY (see `paperclipai agent local-cli <agent>`), or pass --as-board if you really are filing it yourself",
              );
            }
          }
          if (opts.description) {
            const firstContentLine = opts.description.split("\n").find((line) => line.trim().length > 0);
            if (firstContentLine !== undefined && !firstContentLine.startsWith(">")) {
              throw new Error(
                "description must open with a one-line `> quote` summary — only the title shows in lists, so the takeaway goes first",
              );
            }
          }
          // Duplicate guard + similar-issue advisory, both answered by one
          // lightweight server call (MUL-154): the old flow pulled the whole
          // issue list into memory on every create.
          if (!opts.allowDuplicate) {
            const similarParams = new URLSearchParams({ title: opts.title });
            const similar =
              (await ctx.api.get<{ issues: Array<{ identifier: string; title: string; status: string; score: number; exact: boolean }> }>(
                `${apiPath`/api/companies/${ctx.companyId}/issues/similar`}?${similarParams.toString()}`,
              )) ?? { issues: [] };
            const exact = similar.issues.filter((row) => row.exact);
            if (exact.length > 0) {
              const list = exact.map((h) => `${h.identifier} [${h.status}] ${h.title}`).join("\n  ");
              throw new Error(
                `an active issue with this title already exists:\n  ${list}\npass --allow-duplicate to create it anyway`,
              );
            }
            const near = similar.issues.filter((row) => !row.exact);
            if (near.length > 0) {
              // stderr so JSON consumers piping stdout stay clean — the
              // advisory is for the human typing the command.
              //
              // Finished cards appear here too since MUL-441 added the semantic
              // leg. A done card that already answers this is worth more than an
              // open one, not less: nobody is watching it to notice the
              // duplicate. The `[status]` on each line says which is which.
              const list = near.map((h) => `  ${h.identifier} [${h.status}] ${h.title}`).join("\n");
              console.error(
                `related issues (consider --parent-id <id> to file as a sub-task, or ignore):\n${list}\n`,
              );
            }
          }
          const session = resolveSessionIdVerbose(opts.session) ?? undefined;
          const payload = createIssueSchema.parse({
            title: opts.title,
            description: opts.description,
            status: opts.status,
            priority: opts.priority,
            assigneeAgentId: opts.assigneeAgentId,
            projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
            requestDepth: parseOptionalInt(opts.requestDepth),
            billingCode: opts.billingCode,
            createdBySession: session,
            ...(opts.allowDuplicate ? { allowDuplicate: true } : {}),
          });

          const created = await ctx.api.post<Issue>(apiPath`/api/companies/${ctx.companyId}/issues`, payload);
          // Attribution is stamped server-side from the authenticated caller at
          // create time (agent key => createdByAgentId, board => createdByUserId).
          // No client-side backfill: a card is attributed correctly on the first
          // write or not at all — the pre-write identity gate above enforces it.
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("update")
      .description("Update an issue")
      .argument("<issueId>", "Issue ID")
      .option("--title <title>", "Issue title")
      .option("--description <text>", "Issue description")
      .option("--status <status>", "Issue status")
      .option("--priority <priority>", "Issue priority")
      .option("--assignee-agent-id <id>", "Assignee agent ID")
      // Handing a card to a person is the `human_assignee_user_id` review path:
      // an agent cannot move a card to in_review without one of the five paths,
      // and this is the only one that means "a human is looking at it next".
      // The flag was missing, so agents had no way to finish a card from the
      // terminal (MUL-118).
      .option("--assignee-user-id <id>", "Assignee user ID (e.g. local-board) — hands the card to a person and opens the in_review path")
      .option("--project-id <id>", "Project ID")
      .option("--goal-id <id>", "Goal ID")
      .option("--parent-id <id>", "Parent issue ID")
      .option("--request-depth <n>", "Request depth integer")
      .option("--billing-code <code>", "Billing code")
      .option("--comment <text>", "Optional comment to add with update")
      .option("--hidden-at <iso8601|null>", "Set hiddenAt timestamp or literal 'null'")
      // 评审会话 (MUL-456, 写入时机由 MUL-457 改定): an extra note, not a step.
      // Set it when a review is worth pointing back at, leave it alone
      // otherwise. Deliberately NOT wired into `issue qa`: that command files
      // any Q&A pair, and marking every exchange as a review would make the
      // field answer a different question than the one it exists for.
      .option("--reviewer-session <id>", "Session the review ran in (optional — nothing sets this automatically)")
      .option("--reviewer-agent <nameOrId>", "Agent that reviewed, paired with --reviewer-session")
      .action(async (issueId: string, opts: IssueUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          // The agent is named, not an id, for the same reason --answer-agent
          // is: whoever is typing this knows "Codex（Terminal）", not a uuid.
          const reviewerAgentId = opts.reviewerAgent
            ? await agentIdResolver(ctx, ctx.companyId)(opts.reviewerAgent, "--reviewer-agent")
            : undefined;
          const payload = updateIssueSchema.parse({
            title: opts.title,
            description: opts.description,
            status: opts.status,
            priority: opts.priority,
            assigneeAgentId: opts.assigneeAgentId,
            assigneeUserId: opts.assigneeUserId,
            projectId: opts.projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
            requestDepth: parseOptionalInt(opts.requestDepth),
            billingCode: opts.billingCode,
            comment: opts.comment,
            hiddenAt: parseHiddenAt(opts.hiddenAt),
            reviewerSession: opts.reviewerSession,
            reviewerAgentId,
          });

          // Assigning to a person is a handover, not a claim — auto-claiming on
          // top would set an agent assignee and trip the one-assignee rule.
          if (opts.status && !opts.assigneeAgentId && !opts.assigneeUserId) {
            const existing = await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`).catch(() => null);
            if (existing) await autoClaimIfUnclaimed(ctx, existing);
          }
          // preflight 内联 (MUL-555): the gates fire on the way into in_review
          // and done, and `issue preflight` existed but had to be remembered.
          // Printing it here, before the write, means forgetting costs nothing
          // — the same itemized list shows up in place either way. Best-effort
          // on stderr, and skipped under --json so machine consumers still get
          // clean JSON on stdout (same shape as the claim side, MUL-448).
          if (!ctx.json && (opts.status === "in_review" || opts.status === "done")) {
            const report = await ctx.api
              .get<IssuePreflightReport>(apiPath`/api/issues/${issueId}/preflight`)
              .catch(() => null);
            if (report) console.error(`${formatPreflight(report)}\n`);
          }
          const updated = await ctx.api.patch<Issue & { comment?: IssueComment | null }>(apiPath`/api/issues/${issueId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("claim")
      .description("Claim an issue: take ownership (in_progress + assignee) and file an opening note. No branch — that is `issue start`")
      .argument("<issueId>", "Issue ID or identifier")
      .option("--note <text>", "Extra opening note text")
      .option("--status <status>", "Target status (default in_progress)", "in_progress")
      .option("--force", "Claim even when the card is already done or cancelled")
      .action(async (issueId: string, opts: IssueClaimOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const issue = await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`);
          if (!issue) throw new Error(`Issue not found: ${issueId}`);
          assertNotTerminalForWrite(issue, "claim", opts.force);
          let updated: Issue | null = issue;
          // 接卡即开工（user 2026-08-27）: Driving records the claiming agent.
          // Sub-agents it dispatches are its implementation detail and are not
          // recorded anywhere; a new claimant overwrites Driving, which is the
          // intended handover semantics. Auto-filled here because 15 of 18
          // started cards simply had nobody remember to run `issue start`.
          // Driving is patched BEFORE status: the server 409s an agent
          // advancing an unclaimed card (MUL-72), and Driving is the claim
          // marker that opens that gate. Self-assigning instead trips the
          // one-assignee rule (cards default to assigneeUserId=local-board).
          const drivingSession = resolveSessionIdVerbose();
          const me = await ctx.api.get<{ id: string } | null>(apiPath`/api/agents/me`).catch(() => null);
          const drivingAgentId = me?.id ?? process.env.PAPERCLIP_AGENT_ID?.trim() ?? null;
          if (drivingSession || drivingAgentId) {
            const drivingPatch: Record<string, unknown> = {};
            if (drivingSession) drivingPatch.drivingSession = drivingSession;
            if (drivingAgentId) drivingPatch.drivingAgentId = drivingAgentId;
            updated = await ctx.api.patch<Issue>(apiPath`/api/issues/${issue.id}`, drivingPatch).catch(() => updated);
          }
          if (issue.status !== opts.status) {
            updated = await ctx.api.patch<Issue>(apiPath`/api/issues/${issue.id}`, { status: opts.status });
          }
          // 标题回显 (MUL-555): the card number alone cannot be checked by eye.
          // A stale number guessed from an old list is a valid number belonging
          // to someone else's card, so the only thing that makes a mis-claim
          // visible at the moment it happens is the title (MUL-98).
          const lines = [`接卡：${issue.identifier}「${issue.title ?? "(无标题)"}」 → ${opts.status}（by claim command）`];
          if (drivingAgentId || drivingSession) lines.push(`Driving：${drivingAgentId ?? "?"}${drivingSession ? ` · 会话 ${drivingSession}` : ""}`);
          if (opts.note) lines.push(opts.note);
          await ctx.api.post(apiPath`/api/issues/${issue.id}/comments`, {
            body: lines.join("\n"),
            presentation: { kind: "progress_note", tone: "info" },
          });
          printOutput({ identifier: issue.identifier, title: issue.title, status: updated?.status ?? opts.status, drivingAgentId, drivingSession }, { json: ctx.json });
          // 门禁前置可发现 (MUL-448): the moment the card is taken is the
          // moment its debts are worth knowing — printing them at close time
          // is what cost the round trip. Best-effort on stderr so it never
          // breaks the claim itself or pollutes --json consumers.
          if (!ctx.json) {
            const report = await ctx.api
              .get<IssuePreflightReport>(apiPath`/api/issues/${issue.id}/preflight`)
              .catch(() => null);
            if (report) console.error(`\n${formatPreflight(report)}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("start")
      .description("Start work on a claimed issue: record the working branch (and flip to in_progress if needed)")
      .argument("<issueId>", "Issue ID or identifier")
      .requiredOption("--branch <name>", "Working branch name")
      .option("--worktree <path>", "Absolute path to the git worktree")
      .option("--base <ref>", "Base commit/branch this branch was cut from")
      .option("--depends-on <ids>", "Comma-separated issue ids this branch depends on")
      .option("--note <text>", "Extra start note text")
      .option(
        "--session <id>",
        "Driving session to record on the card — who is working it now (one slot, overwritten per start). Defaults to whatever this host terminal publishes; Zcode and Qoder publish nothing, so pass it there",
      )
      .option("--force", "Start even when the card is already done or cancelled")
      .action(async (issueId: string, opts: IssueStartOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const issue = await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`);
          if (!issue) throw new Error(`Issue not found: ${issueId}`);
          assertNotTerminalForWrite(issue, "start", opts.force);
          let updated: Issue | null = issue;
          if (issue.status !== "in_progress") {
            try {
              updated = await ctx.api.patch<Issue>(apiPath`/api/issues/${issue.id}`, { status: "in_progress" });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (!message.includes("require an assignee")) throw err;
              const me = await ctx.api.get<Issue & { id: string }>(apiPath`/api/agents/me`).catch(() => null);
              if (!me?.id) {
                throw new Error("in_progress requires an assignee; claim first or run with --api-key as the working agent");
              }
              updated = await ctx.api.patch<Issue>(apiPath`/api/issues/${issue.id}`, {
                status: "in_progress",
                assigneeAgentId: me.id,
              });
            }
          }
          const drivingSession = resolveSessionIdVerbose(opts.session);
          const drivingPatch: Record<string, unknown> = {};
          // Structured branch column (MUL-59): the branch used to live only in
          // the opening comment's prose. MUL-558: the PATCH must not depend on
          // a session id — Zcode/Qoder terminals publish none, which left
          // workingBranch null and the 代码卡 close-gate's signal dark.
          drivingPatch.workingBranch = opts.branch;
          // /agents/me only answers for an agent key, and an agent key cannot
          // PATCH an in-progress issue without a run — so a board-authenticated
          // terminal falls back to the agent id it was configured with. Without
          // this, Driving stays "Unclaimed" on every card a terminal starts.
          const me = await ctx.api.get<{ id: string } | null>(apiPath`/api/agents/me`).catch(() => null);
          const drivingAgentId = me?.id ?? process.env.PAPERCLIP_AGENT_ID?.trim() ?? null;
          if (drivingAgentId) drivingPatch.drivingAgentId = drivingAgentId;
          if (drivingSession) drivingPatch.drivingSession = drivingSession;
          updated = await ctx.api.patch<Issue>(apiPath`/api/issues/${issue.id}`, drivingPatch);
          if (!drivingPatch.drivingAgentId) {
            process.stderr.write("warning: no agent identity for Driving — set PAPERCLIP_AGENT_ID or run with an agent key\n");
          }
          const lines = [`开工：${issue.identifier}「${issue.title ?? "(无标题)"}」，工作分支：${opts.branch}`];
          if (drivingSession) lines.push(`主审会话：${drivingSession}`);
          if (opts.worktree) lines.push(`工作树：${opts.worktree}`);
          if (opts.base) lines.push(`基线：${opts.base}`);
          if (opts.dependsOn) lines.push(`依赖：${opts.dependsOn}`);
          if (opts.note) lines.push(opts.note);
          await ctx.api.post(apiPath`/api/issues/${issue.id}/comments`, {
            body: lines.join("\n"),
            presentation: { kind: "progress_note", tone: "info" },
          });
          printOutput({ identifier: issue.identifier, title: issue.title, status: updated?.status ?? "in_progress", branch: opts.branch, drivingSession }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("progress")
      .description("File a progress note on an issue (compact ledger entry)")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<text>", "Progress note text")
      .option("--tone <tone>", "info | success | warning | danger", "info")
      .action(async (issueId: string, text: string, opts: IssueProgressOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const issue = await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`);
          if (!issue) throw new Error(`Issue not found: ${issueId}`);
          await autoClaimIfUnclaimed(ctx, issue);
          const comment = await ctx.api.post<IssueComment>(apiPath`/api/issues/${issue.id}/comments`, {
            body: text,
            presentation: { kind: "progress_note", tone: opts.tone },
          });
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment")
      .description("Add comment to issue")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--body <text>", "Comment body")
      .option("--reopen", "Reopen if issue is done/cancelled")
      .option("--resume", "Request explicit follow-up and wake the assignee when resumable")
      .action(async (issueId: string, opts: IssueCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = addIssueCommentSchema.parse({
            body: opts.body,
            reopen: opts.reopen,
            resume: opts.resume,
          });
          const comment = await ctx.api.post<IssueComment>(apiPath`/api/issues/${issueId}/comments`, payload);
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comments")
      .description("List issue comments")
      .argument("<issueId>", "Issue ID")
      .option("--after-comment-id <id>", "Only return comments after this comment ID")
      .option("--order <order>", "asc or desc")
      .option("--limit <n>", "Maximum comments to return")
      .action(async (issueId: string, opts: IssueCommentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.afterCommentId) params.set("afterCommentId", opts.afterCommentId);
          if (opts.order) params.set("order", opts.order);
          if (opts.limit) params.set("limit", opts.limit);
          const query = params.toString();
          const comments = (await ctx.api.get<IssueComment[]>(
            `${apiPath`/api/issues/${issueId}/comments`}${query ? `?${query}` : ""}`,
          )) ?? [];
          printOutput(comments, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment:get")
      .description("Get one issue comment")
      .argument("<issueId>", "Issue ID")
      .argument("<commentId>", "Comment ID")
      .action(async (issueId: string, commentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const comment = await ctx.api.get<IssueComment>(apiPath`/api/issues/${issueId}/comments/${commentId}`);
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment:delete")
      .description("Delete or cancel one issue comment")
      .argument("<issueId>", "Issue ID")
      .argument("<commentId>", "Comment ID")
      .action(async (issueId: string, commentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<IssueComment>(apiPath`/api/issues/${issueId}/comments/${commentId}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("approvals")
      .description("List approvals linked to an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const approvals = await ctx.api.get(apiPath`/api/issues/${issueId}/approvals`);
          printOutput(approvals, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("approval:link")
      .description("Link an approval to an issue")
      .argument("<issueId>", "Issue ID")
      .argument("<approvalId>", "Approval ID")
      .action(async (issueId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = linkIssueApprovalSchema.parse({ approvalId });
          const approvals = await ctx.api.post(apiPath`/api/issues/${issueId}/approvals`, payload);
          printOutput(approvals, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("approval:unlink")
      .description("Unlink an approval from an issue")
      .argument("<issueId>", "Issue ID")
      .argument("<approvalId>", "Approval ID")
      .action(async (issueId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/issues/${issueId}/approvals/${approvalId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addIssuePostDeleteMarkerCommand(issue, "read", "Mark an issue as read", "post", "/read");
  addIssuePostDeleteMarkerCommand(issue, "unread", "Mark an issue as unread", "delete", "/read");
  // `archive` / `unarchive` now mean the card itself (MUL-109). The per-user
  // inbox versions keep working under names that match their endpoint.
  addIssuePostDeleteMarkerCommand(issue, "inbox-archive", "Archive an issue from your inbox", "post", "/inbox-archive");
  addIssuePostDeleteMarkerCommand(issue, "inbox-unarchive", "Unarchive an issue from your inbox", "delete", "/inbox-archive");

  addCommonClientOptions(
    issue
      .command("recovery-actions")
      .description("List active recovery actions for an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/issues/${issueId}/recovery-actions`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("recovery:resolve")
      .description("Resolve an issue recovery action")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--outcome <outcome>", "restored, false_positive, blocked, or cancelled")
      .requiredOption("--source-issue-status <status>", "todo, done, or in_review for restored outcomes; blocked is only valid for blocked outcomes")
      .option("--action-id <id>", "Specific recovery action ID")
      .option("--resolution-note <text>", "Resolution note")
      .action(async (issueId: string, opts: IssueRecoveryResolveOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resolveIssueRecoveryActionSchema.parse({
            actionId: opts.actionId,
            outcome: opts.outcome,
            sourceIssueStatus: opts.sourceIssueStatus,
            resolutionNote: opts.resolutionNote,
          });
          const result = await ctx.api.post(apiPath`/api/issues/${issueId}/recovery-actions/resolve`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("child:create")
      .description("Create a child issue from a JSON payload")
      .argument("<issueId>", "Parent issue ID")
      .requiredOption("--payload-json <json>", "CreateChildIssue JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createChildIssueSchema.parse(parseJson(opts.payloadJson));
          const child = await ctx.api.post<Issue>(apiPath`/api/issues/${issueId}/children`, payload);
          printOutput(child, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("force-release")
      .description("Force-release an issue from an agent checkout")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(apiPath`/api/issues/${issueId}/admin/force-release`, {});
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-products")
      .description("List issue work products")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await ctx.api.get(apiPath`/api/issues/${issueId}/work-products`);
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

/**
 * openspec 链接：卡上挂的是 store 里的一条路径，不是内容的副本。store 是服务端
 * 磁盘上的 git 检出，所以路径在哪个环境都成立，而一条写死的 URL 会带着写入时
 * 的域名和公司前缀，换个环境就废。前端拿这个路径现拼跳转链接。
 */
const OPENSPEC_WORK_PRODUCT_TYPE = "openspec";

type OpenSpecLinkOptions = BaseClientOptions & { title?: string };

type OpenSpecChangeMatch = { path: string; name: string; archived: boolean; matchedIn: string[] };

/**
 * store 里提到这张卡的 change。收卡那一刻问一次，把「这卡走过 openspec 但没挂
 * 回来」捞出来。答案每次现算，不留登记，所以 change 改名或归档后照样找得到。
 */
async function fetchChangesForIssue(
  ctx: ResolvedClientContext,
  identifier: string,
): Promise<OpenSpecChangeMatch[]> {
  const result = await ctx.api.get<{ available: boolean; root: string; changes: OpenSpecChangeMatch[] }>(
    `${apiPath`/api/companies/${ctx.companyId}/openspec/changes-for-issue`}?identifier=${encodeURIComponent(identifier)}`,
  );
  if (!result?.available) {
    throw new Error(`服务端没找到 openspec 仓（读取路径 ${result?.root ?? "未知"}）。`);
  }
  return result.changes ?? [];
}

/** store 里的全部可读文件，用来判断一条路径是不是真的存在。 */
async function fetchOpenSpecFiles(ctx: ResolvedClientContext): Promise<string[]> {
  const listing = await ctx.api.get<{ available: boolean; root: string; files: Array<{ path: string }> }>(
    apiPath`/api/companies/${ctx.companyId}/openspec/files`,
  );
  if (!listing?.available) {
    throw new Error(`服务端没找到 openspec 仓（读取路径 ${listing?.root ?? "未知"}），先把它检出到位再挂链接。`);
  }
  return (listing.files ?? []).map((file) => file.path);
}

/** 去掉首尾斜杠，让 `/changes/x/` 和 `changes/x` 存成同一条。 */
function normalizeStorePath(input: string): string {
  return input.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * 路径必须指向 store 里真实存在的东西：一个文件，或一个装着文件的目录。挂之前
 * 就报错，比让人点开才发现「不在仓里」强——链接写错的那一刻离得越近越好改。
 */
function assertStorePathExists(storePath: string, filePaths: string[]): { isDirectory: boolean } {
  if (filePaths.includes(storePath)) return { isDirectory: false };
  const prefix = `${storePath}/`;
  if (filePaths.some((path) => path.startsWith(prefix))) return { isDirectory: true };
  const near = filePaths.filter((path) => path.includes(storePath.split("/").pop() ?? "")).slice(0, 5);
  throw new Error(
    [
      `openspec 仓里没有这条路径：${storePath}`,
      near.length > 0 ? `形近的有：\n  ${near.join("\n  ")}` : "路径从 store 根算起，通常以 openspec/ 开头；OpenSpec 页签里的目录树就是它。",
    ].join("\n"),
  );
}

/**
 * 标题默认从路径推：目录用它自己的名字，文件带上所属 change，因为一张卡可能挂
 * 好几个 change 的 proposal.md，只写文件名分不出是哪个。面板第二行本来就显示
 * 完整路径，所以标题只要够认出是哪一份就行。
 */
function defaultOpenSpecTitle(storePath: string, isDirectory: boolean): string {
  const segments = storePath.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? storePath;
  // 归档目录名带 `2026-09-09-` 这样的日期前缀。日期在标题里占掉半行又说不出
  // 是哪个 change，剥掉；面板第二行显示的完整路径里它还在，需要时看得到。
  const changeName = (name: string) => name.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  if (isDirectory) return changeName(last);
  const parent = segments[segments.length - 2];
  return parent ? `${changeName(parent)}/${last}` : last;
}

/** 归档过的 change 住在 `changes/archive/` 下，状态跟着路径走，不用每次手写。 */
function openSpecStatusFor(storePath: string): "active" | "archived" {
  return storePath.includes("/archive/") ? "archived" : "active";
}

function openSpecLinkRows(rows: unknown): Array<{ id: string; title: string; storePath: string | null; status: string }> {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, any> =>
      Boolean(row) && (row as Record<string, unknown>).type === OPENSPEC_WORK_PRODUCT_TYPE)
    .map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      storePath: typeof row.metadata?.storePath === "string" ? row.metadata.storePath : null,
      status: String(row.status ?? ""),
    }));
}

  addCommonClientOptions(
    issue
      .command("openspec:link")
      .description("Attach an openspec change to an issue. Omit the path to find it by card number (close-out check)")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("[storePath]", "Store-relative path; omit to search the store for changes naming this card")
      .option("--title <title>", "Display title (defaults to the change or file name)")
      .action(async (issueId: string, storePathArg: string | undefined, opts: OpenSpecLinkOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const issue = await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`);
          if (!issue) throw new Error(`Issue not found: ${issueId}`);

          // 收卡用法：不给路径就按卡号去 store 里找。命中唯一才自动挂——多个
          // 候选时挑哪个是判断，不是查找，挂错了比没挂更难发现。
          let resolvedPathArg = storePathArg;
          if (!resolvedPathArg) {
            const identifier = issue.identifier ?? issueId;
            const matches = await fetchChangesForIssue(ctx, identifier);
            if (matches.length === 0) {
              console.log(`store 里没有提到 ${identifier} 的 change，这张卡没走 openspec，不用挂。`);
              return;
            }
            if (matches.length > 1) {
              console.log(`store 里有 ${matches.length} 个 change 提到 ${identifier}，挑一个再挂：`);
              for (const match of matches) {
                console.log(`  ${match.path}${match.archived ? "  [archived]" : ""}`);
                console.log(`    命中于 ${match.matchedIn.join("、")}`);
              }
              console.log(`\n挂法：paperclipai issue openspec:link ${identifier} <上面的路径>`);
              return;
            }
            resolvedPathArg = matches[0]!.path;
            console.log(`按卡号找到唯一 change：${resolvedPathArg}`);
          }

          const storePath = normalizeStorePath(resolvedPathArg);
          const { isDirectory } = assertStorePathExists(storePath, await fetchOpenSpecFiles(ctx));
          const title = opts.title?.trim() || defaultOpenSpecTitle(storePath, isDirectory);

          // 同一条路径挂第二次改的是已有那条，不是再堆一行：重跑一次命令是常态
          // （换了标题、脚本重放），重复的行只会让面板越读越乱。
          const existing = openSpecLinkRows(
            await ctx.api.get(apiPath`/api/issues/${issue.id}/work-products`),
          ).find((row) => row.storePath === storePath);
          if (existing) {
            const updated = await ctx.api.patch(apiPath`/api/work-products/${existing.id}`, {
              title,
              status: openSpecStatusFor(storePath),
            });
            printOutput(updated, { json: ctx.json });
            return;
          }

          const created = await ctx.api.post(apiPath`/api/issues/${issue.id}/work-products`, {
            type: OPENSPEC_WORK_PRODUCT_TYPE,
            provider: "paperclip",
            title,
            status: openSpecStatusFor(storePath),
            metadata: { storePath },
          });
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("openspec:unlink")
      .description("Remove an openspec link from an issue by its store path")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<storePath>", "The store path that was linked")
      .action(async (issueId: string, storePathArg: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const issue = await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`);
          if (!issue) throw new Error(`Issue not found: ${issueId}`);
          const storePath = normalizeStorePath(storePathArg);
          const match = openSpecLinkRows(
            await ctx.api.get(apiPath`/api/issues/${issue.id}/work-products`),
          ).find((row) => row.storePath === storePath);
          if (!match) throw new Error(`这张卡上没挂 ${storePath}`);
          await ctx.api.delete(apiPath`/api/work-products/${match.id}`);
          printOutput({ removed: match.id, storePath }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("openspec:links")
      .description("List the openspec links on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const issue = await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`);
          if (!issue) throw new Error(`Issue not found: ${issueId}`);
          const rows = openSpecLinkRows(
            await ctx.api.get(apiPath`/api/issues/${issue.id}/work-products`),
          );
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            console.log("这张卡还没挂 openspec。用 `issue openspec:link <卡号> <路径>` 挂上。");
            return;
          }
          for (const row of rows) console.log(`${row.title}  [${row.status}]\n  ${row.storePath ?? "(没有路径)"}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-product:create")
      .description("Create an issue work product from JSON")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--payload-json <json>", "CreateIssueWorkProduct JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createIssueWorkProductSchema.parse(parseJson(opts.payloadJson));
          // MUL-603：飞书 wiki 通路的链接创建时就验真——服务端收卡门禁看不见飞书正文。
          await assertFeishuIssueWikiWorkProduct(payload);
          const product = await ctx.api.post(apiPath`/api/issues/${issueId}/work-products`, payload);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-product:update")
      .description("Update a work product from JSON")
      .argument("<workProductId>", "Work product ID")
      .requiredOption("--payload-json <json>", "UpdateIssueWorkProduct JSON payload")
      .action(async (workProductId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateIssueWorkProductSchema.parse(parseJson(opts.payloadJson));
          const product = await ctx.api.patch(apiPath`/api/work-products/${workProductId}`, payload);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-product:delete")
      .description("Delete a work product")
      .argument("<workProductId>", "Work product ID")
      .action(async (workProductId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const product = await ctx.api.delete(apiPath`/api/work-products/${workProductId}`);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // 门禁前置可发现 (MUL-448): ask what would block you on this card before
  // doing the work, instead of learning it from a 409/422 after.
  addCommonClientOptions(
    issue
      .command("preflight")
      .description("Ask what would block your next write on this issue (claim gate, close gate, adjudication mode)")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const report = await ctx.api.get<IssuePreflightReport>(apiPath`/api/issues/${issueId}/preflight`);
          if (!report) throw new Error(`Issue not found: ${issueId}`);
          if (ctx.json) {
            printOutput(report, { json: true });
            return;
          }
          printOutput(formatPreflight(report), { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("documents")
      .description("List issue documents")
      .argument("<issueId>", "Issue ID")
      .option("--include-system", "Include system documents")
      .action(async (issueId: string, opts: BaseClientOptions & { includeSystem?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.includeSystem ? "?includeSystem=true" : "";
          const docs = await ctx.api.get(`${apiPath`/api/issues/${issueId}/documents`}${query}`);
          await noteDoneIsPastForIssue(ctx, issueId);
          printOutput(docs, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:get")
      .description("Get an issue document")
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          let doc: unknown;
          try {
            doc = await ctx.api.get(apiPath`/api/issues/${issueId}/documents/${key}`);
          } catch (err) {
            // MUL-467: a key with a known shape hands back its skeleton instead
            // of only a 404, so the writer sees the template at the one moment
            // it is missing — the first write. Appends already carry it, since
            // put is destructive and forces a read-back first.
            const skeleton = err instanceof ApiRequestError && err.status === 404 ? documentSkeleton(key) : undefined;
            if (!skeleton) throw err;
            if (ctx.json) {
              printOutput({ exists: false, key, skeleton }, { json: true });
            } else {
              console.error(`文档 ${key} 还不存在。下面是它的骨架，填完用 document:put 写入：`);
              console.log(skeleton);
            }
            return;
          }
          await noteDoneIsPastForIssue(ctx, issueId);
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:put")
      .description("Create or update an issue document")
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .option("--title <title>", "Document title")
      .option("--format <format>", "Document format", "markdown")
      .option("--body <markdown>", "Document body")
      .option("--body-file <path>", "Read document body from a file")
      .option("--change-summary <text>", "Change summary")
      .option("--base-revision-id <id>", "Expected base revision ID")
      .action(async (issueId: string, key: string, opts: IssueDocumentPutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const body = opts.bodyFile ? await readFile(opts.bodyFile, "utf8") : opts.body;
          const doc = await upsertIssueDocument(ctx, issueId, key, {
            title: opts.title,
            format: opts.format,
            body,
            changeSummary: opts.changeSummary,
            baseRevisionId: opts.baseRevisionId,
          });
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:image")
      .description("Upload an image and append it to an issue document")
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .requiredOption("--file <path>", "Image file path (png/jpg/webp/gif)")
      .option("-C, --company-id <id>", "Company ID")
      .option("--caption <text>", "Alt text (defaults to the file name)")
      .option("--title <text>", "Document title (only used when the document is created)")
      .option("--change-summary <text>", "Change summary")
      .action(async (issueId: string, key: string, opts: IssueDocumentImageOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (!IMAGE_FILE_EXTENSION_RE.test(opts.file)) {
            throw new Error("document:image 只收 png/jpg/webp/gif；其他文件走 issue attachment:upload");
          }
          // 先传文件再动文档：传坏了文档保持原样。走附件端点而不是纯 asset，
          // 图片同时挂到卡上（附件列表可见），文档里嵌 asset 的规范 URL。
          const uploaded = (await uploadAttachment(ctx.api.apiBase, ctx.api.apiKey, {
            companyId: ctx.companyId ?? "",
            issueId,
            filePath: opts.file,
            runId: ctx.api.runId,
          })) as { assetId?: string; contentType?: string | null; originalFilename?: string | null } | null;
          if (!uploaded?.assetId) {
            throw new Error("上传成功但响应缺 assetId——文档未改动，文件应已挂在卡上，用 issue attachments 查看");
          }
          if (!(uploaded.contentType ?? "").startsWith("image/")) {
            throw new Error(`只能嵌图片，服务端判定为 ${uploaded.contentType ?? "unknown"}——文档未改动，文件已作为附件挂在卡上`);
          }
          const caption = (opts.caption?.trim() || uploaded.originalFilename || "image").replace(/[[\]]/g, "");
          const src = `/api/assets/${uploaded.assetId}/content`;
          const imageLine = `![${caption}](${src})`;
          const path = apiPath`/api/issues/${issueId}/documents/${key}`;
          const prev = await ctx.api.get<{ body?: string }>(path).catch(() => null);
          const prevBody = (prev?.body ?? "").replace(/\s+$/, "");
          const body = prevBody ? `${prevBody}\n\n${imageLine}\n` : `${imageLine}\n`;
          const doc = await upsertIssueDocument(ctx, issueId, key, {
            title: opts.title,
            body,
            changeSummary: opts.changeSummary ?? `append 图片：${caption}`,
          });
          if (!ctx.json) console.error(`已上传并嵌入 ${src}`);
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("interactions")
      .description("List issue thread interactions")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const interactions = await ctx.api.get(apiPath`/api/issues/${issueId}/interactions`);
          printOutput(interactions, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("interaction:create")
      .description("Create an issue thread interaction from JSON")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--payload-json <json>", "CreateIssueThreadInteraction JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createIssueThreadInteractionSchema.parse(parseJson(opts.payloadJson));
          const interaction = await ctx.api.post(apiPath`/api/issues/${issueId}/interactions`, payload);
          printOutput(interaction, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("interaction:accept")
      .description("Accept an issue thread interaction")
      .argument("<issueId>", "Issue ID")
      .argument("<interactionId>", "Interaction ID")
      .option("--selected-client-keys <csv>", "Client keys to accept")
      .option("--selected-option-ids <csv>", "Checkbox option IDs to accept")
      .action(async (issueId: string, interactionId: string, opts: InteractionAcceptOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = acceptIssueThreadInteractionSchema.parse({
            selectedClientKeys: opts.selectedClientKeys === undefined ? undefined : parseCsv(opts.selectedClientKeys),
            selectedOptionIds: opts.selectedOptionIds === undefined ? undefined : parseCsv(opts.selectedOptionIds),
          });
          const interaction = await ctx.api.post(apiPath`/api/issues/${issueId}/interactions/${interactionId}/accept`, payload);
          printOutput(interaction, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, action, schema, description] of [
    ["interaction:reject", "reject", rejectIssueThreadInteractionSchema, "Reject an issue thread interaction"],
    ["interaction:cancel", "cancel", cancelIssueThreadInteractionSchema, "Cancel an issue thread interaction"],
  ] as const) {
    addCommonClientOptions(
      issue
        .command(name)
        .description(description)
        .argument("<issueId>", "Issue ID")
        .argument("<interactionId>", "Interaction ID")
        .option("--reason <text>", "Reason")
        .action(async (issueId: string, interactionId: string, opts: InteractionReasonOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const payload = schema.parse({ reason: opts.reason });
            const interaction = await ctx.api.post(`${apiPath`/api/issues/${issueId}/interactions/${interactionId}`}/${action}`, payload);
            printOutput(interaction, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    issue
      .command("interaction:respond")
      .description("Respond to an issue question interaction")
      .argument("<issueId>", "Issue ID")
      .argument("<interactionId>", "Interaction ID")
      .requiredOption("--answers-json <json>", "Answers array JSON")
      .option("--summary-markdown <markdown>", "Optional response summary")
      .action(async (issueId: string, interactionId: string, opts: InteractionRespondOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = respondIssueThreadInteractionSchema.parse({
            answers: parseJson(opts.answersJson),
            summaryMarkdown: opts.summaryMarkdown,
          });
          const interaction = await ctx.api.post(apiPath`/api/issues/${issueId}/interactions/${interactionId}/respond`, payload);
          printOutput(interaction, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-state")
      .description("Get issue tree control state")
      .argument("<issueId>", "Root issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const state = await ctx.api.get(apiPath`/api/issues/${issueId}/tree-control/state`);
          printOutput(state, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-preview")
      .description("Preview issue tree control changes")
      .argument("<issueId>", "Root issue ID")
      .requiredOption("--payload-json <json>", "PreviewIssueTreeControl JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = previewIssueTreeControlSchema.parse(parseJson(opts.payloadJson));
          const preview = await ctx.api.post(apiPath`/api/issues/${issueId}/tree-control/preview`, payload);
          printOutput(preview, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-holds")
      .description("List issue tree holds")
      .argument("<issueId>", "Root issue ID")
      .option("--status <status>", "active or released")
      .option("--mode <mode>", "pause, resume, cancel, or restore")
      .option("--include-members", "Include hold members")
      .action(async (issueId: string, opts: TreeHoldListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.mode) params.set("mode", opts.mode);
          if (opts.includeMembers) params.set("includeMembers", "true");
          const query = params.toString();
          const holds = await ctx.api.get(`${apiPath`/api/issues/${issueId}/tree-holds`}${query ? `?${query}` : ""}`);
          printOutput(holds, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-hold:create")
      .description("Create an issue tree hold from JSON")
      .argument("<issueId>", "Root issue ID")
      .requiredOption("--payload-json <json>", "CreateIssueTreeHold JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createIssueTreeHoldSchema.parse(parseJson(opts.payloadJson));
          const hold = await ctx.api.post(apiPath`/api/issues/${issueId}/tree-holds`, payload);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-hold:get")
      .description("Get an issue tree hold")
      .argument("<issueId>", "Root issue ID")
      .argument("<holdId>", "Hold ID")
      .action(async (issueId: string, holdId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const hold = await ctx.api.get(apiPath`/api/issues/${issueId}/tree-holds/${holdId}`);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-hold:release")
      .description("Release an issue tree hold")
      .argument("<issueId>", "Root issue ID")
      .argument("<holdId>", "Hold ID")
      .option("--payload-json <json>", "ReleaseIssueTreeHold JSON payload", "{}")
      .action(async (issueId: string, holdId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = releaseIssueTreeHoldSchema.parse(parseJson(opts.payloadJson));
          const hold = await ctx.api.post(apiPath`/api/issues/${issueId}/tree-holds/${holdId}/release`, payload);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("attachments")
      .description("List issue attachments")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const attachments = await ctx.api.get(apiPath`/api/issues/${issueId}/attachments`);
          printOutput(attachments, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("attachment:upload")
      .description("Upload an issue attachment")
      .argument("<issueId>", "Issue ID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--file <path>", "File to upload")
      .option("--comment-id <id>", "Attach to an issue comment")
      .action(async (issueId: string, opts: IssueAttachmentUploadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const attachment = await uploadAttachment(ctx.api.apiBase, ctx.api.apiKey, {
            companyId: ctx.companyId ?? "",
            issueId,
            filePath: opts.file,
            commentId: opts.commentId,
            runId: ctx.api.runId,
          });
          printOutput(attachment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("attachment:download")
      .description("Download an attachment")
      .argument("<attachmentId>", "Attachment ID")
      .option("--out <path>", "Output file path; prints to stdout when omitted")
      .action(async (attachmentId: string, opts: IssueAttachmentDownloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const bytes = await downloadAttachment(ctx.api.apiBase, ctx.api.apiKey, attachmentId);
          if (opts.out) {
            await writeFile(opts.out, bytes);
            if (ctx.json) printOutput({ out: opts.out, bytes: bytes.byteLength }, { json: true });
            else console.log(`Wrote ${bytes.byteLength} byte(s) to ${opts.out}`);
            return;
          }
          process.stdout.write(bytes);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("attachment:delete")
      .description("Delete an attachment")
      .argument("<attachmentId>", "Attachment ID")
      .action(async (attachmentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/attachments/${attachmentId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("label:list")
      .description("List issue labels in a company")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const labels = await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/labels`);
          printOutput(labels, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("label:create")
      .description("Create an issue label")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Label name")
      .requiredOption("--color <hex>", "Label color, e.g. #4f46e5")
      .action(async (opts: IssueLabelCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createIssueLabelSchema.parse({ name: opts.name, color: opts.color });
          const label = await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/labels`, payload);
          printOutput(label, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("label:delete")
      .description("Delete an issue label")
      .argument("<labelId>", "Label ID")
      .action(async (labelId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/labels/${labelId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:votes")
      .description("List feedback votes for an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const votes = await ctx.api.get(apiPath`/api/issues/${issueId}/feedback-votes`);
          printOutput(votes, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:vote")
      .description("Create or update a feedback vote")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--payload-json <json>", "UpsertIssueFeedbackVote JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = upsertIssueFeedbackVoteSchema.parse(parseJson(opts.payloadJson));
          const vote = await ctx.api.post(apiPath`/api/issues/${issueId}/feedback-votes`, payload);
          printOutput(vote, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, pathSuffix, description] of [
    ["document:delete", "", "Delete an issue document"],
    ["document:lock", "/lock", "Lock an issue document"],
    ["document:unlock", "/unlock", "Unlock an issue document"],
  ] as const) {
    addCommonClientOptions(
      issue
        .command(name)
        .description(description)
        .argument("<issueId>", "Issue ID")
        .argument("<key>", "Document key")
        .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const path = `${apiPath`/api/issues/${issueId}/documents/${key}`}${pathSuffix}`;
            const result = name === "document:delete" ? await ctx.api.delete(path) : await ctx.api.post(path, {});
            printOutput(result, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    issue
      .command("decisions:pull")
      .description("Pull the settled entries out of this card's decision-log — step 1 of 拉 + 提炼 + 给老板审 (MUL-465)")
      .argument("<issueId>", "Issue ID")
      .option("--all", "Include unsettled and overturned entries, tagged with their status")
      .action(async (issueId: string, opts: BaseClientOptions & { all?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts);
          const doc = await ctx.api
            .get<{ body?: string }>(apiPath`/api/issues/${issueId}/documents/decision-log`)
            .catch((err) => {
              if (err instanceof ApiRequestError && err.status === 404) return null;
              throw err;
            });
          if (!doc) {
            console.error("这张卡还没有 decision-log。先把讨论记下来：issue document:get <卡> decision-log 会给你骨架。");
            return;
          }
          const all = parseDecisionLogEntries(doc.body ?? "");
          const picked = opts.all ? all : all.filter(isSettledDecisionLogEntry);
          const unwritten = findUnwrittenOverturns(all);
          if (unwritten.length > 0) {
            console.error(
              `⚠ 有 ${unwritten.length} 处推翻没回写状态行，下面的条目会被当成仍然有效：\n` +
                unwritten.map((u) => `  第 ${u.by} 条说推翻了第 ${u.target} 条，但第 ${u.target} 条状态还是「已定」`).join("\n") +
                `\n修法：把第 N 条的状态行改成「已被第 M 条推翻」，与追加新条目放进同一次 document:put。\n`,
            );
          }
          if (ctx.json) {
            printOutput({ total: all.length, settled: all.filter(isSettledDecisionLogEntry).length, entries: picked }, { json: true });
            return;
          }
          if (all.length === 0) {
            console.error("decision-log 里没有认得出的条目。模板是 `## <编号> · <日期> · <状态>`，见 MUL-467 的 spec。");
            return;
          }
          // 计数先行：提炼前要知道自己在拿几条里的几条，漏了才看得出来。
          console.error(`decision-log 共 ${all.length} 条，其中已定 ${all.filter(isSettledDecisionLogEntry).length} 条。下面是${opts.all ? "全部" : "已定的"}原料，提炼路线选项时以它为准：\n`);
          console.log(picked.map((e) => e.body).join("\n\n---\n\n"));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("decisions:snapshot")
      .description("Regenerate this card's settled-decisions table from its decision-log — 全量重新生成，不局部手改")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const logPath = apiPath`/api/issues/${issueId}/documents/decision-log`;
          const targetPath = apiPath`/api/issues/${issueId}/documents/settled-decisions`;
          const log = await ctx.api
            .get<{ body?: string; latestRevisionId?: string | null }>(logPath)
            .catch((err) => {
              if (err instanceof ApiRequestError && err.status === 404) return null;
              throw err;
            });
          if (!log) {
            if (ctx.json) printOutput({ changed: false, reason: "no-decision-log" }, { json: true });
            else console.error("这张卡还没有 decision-log，没有可快照的决策。");
            return;
          }
          const snapshot = buildSettledDecisionsSnapshot(log.body ?? "");
          if (snapshot.settled === 0) {
            if (ctx.json) printOutput({ changed: false, reason: "nothing-settled", ...snapshot }, { json: true });
            else console.error(`decision-log 共 ${snapshot.total} 条，当前已定 0 条，不生成空表。`);
            return;
          }
          const body = renderSettledDecisionsDocument({
            issueId,
            sourceRevisionId: log.latestRevisionId ?? null,
            snapshot,
          });
          const existing = await ctx.api
            .get<{ body?: string; latestRevisionId?: string | null }>(targetPath)
            .catch((err) => {
              if (err instanceof ApiRequestError && err.status === 404) return null;
              throw err;
            });
          if (existing && (existing.body ?? "") === body) {
            if (ctx.json) printOutput({ changed: false, reason: "unchanged", ...snapshot }, { json: true });
            else console.error("与现有 settled-decisions 逐字相同，无变化，未产生新 revision。");
            return;
          }
          const payload = upsertIssueDocumentSchema.parse({
            title: `settled-decisions · ${issueId}`,
            format: "markdown",
            body,
            changeSummary: `从 decision-log 重新生成：已定 ${snapshot.settled} 条，结构化完整 ${snapshot.complete} 条`,
            baseRevisionId: existing?.latestRevisionId ?? undefined,
          });
          let doc: unknown;
          try {
            doc = await ctx.api.put(targetPath, payload);
          } catch (err) {
            // 快照是全量覆盖，盲目 re-base 会抹掉别人刚写的那版，所以冲突一律交回调用方。
            if (err instanceof ApiRequestError && err.status === 409) {
              throw new Error(
                `并发冲突：settled-decisions 在这次读与写之间被别人改过（${err.message}）。重跑一次 decisions:snapshot 即可，它会基于最新版重新生成。`,
              );
            }
            throw err;
          }
          if (ctx.json) {
            printOutput({ changed: true, ...snapshot, document: doc }, { json: true });
            return;
          }
          console.error(
            `已写入 settled-decisions：已定 ${snapshot.settled} 条，结构化完整 ${snapshot.complete} 条` +
              (snapshot.gapEntryNumbers.length > 0
                ? `，缺口条目第 ${snapshot.gapEntryNumbers.join(", ")} 条（需读 decision-log 原文）`
                : "") +
              "\n",
          );
          console.log(body);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:revisions")
      .description("List issue document revisions, or print one revision's full body with --rev")
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .option("--rev <n>", "Print the full body of this revision number")
      .action(async (issueId: string, key: string, opts: IssueDocumentRevisionsOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const revisions =
            (await ctx.api.get<IssueDocumentRevision[]>(
              apiPath`/api/issues/${issueId}/documents/${key}/revisions`,
            )) ?? [];

          if (opts.rev !== undefined) {
            const wanted = Number(opts.rev);
            if (!Number.isInteger(wanted)) {
              throw new Error(`--rev 要一个版本号整数，收到 ${opts.rev}`);
            }
            const hit = revisions.find((rev) => rev.revisionNumber === wanted);
            if (!hit) {
              const have = revisions.map((rev) => rev.revisionNumber).join(", ");
              throw new Error(
                `${key} 没有第 ${wanted} 版${have ? `；现有版本：${have}` : "（这张卡下没有这个文档，用 issue documents 看有哪些）"}`,
              );
            }
            if (ctx.json) {
              printOutput(hit, { json: true });
            } else {
              // 逐字节写正文：console.log 会补一个换行，取回的版本就不再与服务端一致。
              process.stdout.write(hit.body ?? "");
            }
            return;
          }

          if (ctx.json) {
            printOutput(revisions, { json: true });
            return;
          }
          if (revisions.length === 0) {
            console.log(`${key} 没有版本记录（这张卡下可能没有这个文档，用 issue documents 看有哪些）`);
            return;
          }
          const authors = await resolveRevisionAuthorNames(ctx, revisions);
          console.log(`${key} · ${revisions.length} 版`);
          for (const rev of revisions) {
            const author = rev.createdByAgentId
              ? (authors.get(rev.createdByAgentId) ?? rev.createdByAgentId)
              : (rev.createdByUserId ?? "-");
            // 末尾的 id 是 document:restore 要的 revisionId，清单里给出才不用再翻 --json。
            console.log(
              `  r${rev.revisionNumber}  ${rev.createdAt}  ${(rev.body ?? "").length} 字  ${author}  ${rev.id}`,
            );
            if (rev.changeSummary) console.log(`      ${rev.changeSummary}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:restore")
      .description("Restore an issue document revision")
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .argument("<revisionId>", "Revision ID")
      .action(async (issueId: string, key: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = restoreIssueDocumentRevisionSchema.parse({});
          const doc = await ctx.api.post(
            apiPath`/api/issues/${issueId}/documents/${key}/revisions/${revisionId}/restore`,
            payload,
          );
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:list")
      .description("List feedback traces for an issue")
      .argument("<issueId>", "Issue ID")
      .option("--target-type <type>", "Filter by target type")
      .option("--vote <vote>", "Filter by vote value")
      .option("--status <status>", "Filter by trace status")
      .option("--from <iso8601>", "Only include traces created at or after this timestamp")
      .option("--to <iso8601>", "Only include traces created at or before this timestamp")
      .option("--shared-only", "Only include traces eligible for sharing/export")
      .option("--include-payload", "Include stored payload snapshots in the response")
      .action(async (issueId: string, opts: IssueFeedbackOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const traces = (await ctx.api.get<FeedbackTrace[]>(
            `${apiPath`/api/issues/${issueId}/feedback-traces`}${buildFeedbackTraceQuery(opts)}`,
          )) ?? [];
          if (ctx.json) {
            printOutput(traces, { json: true });
            return;
          }
          printOutput(
            traces.map((trace) => ({
              id: trace.id,
              issue: trace.issueIdentifier ?? trace.issueId,
              vote: trace.vote,
              status: trace.status,
              targetType: trace.targetType,
              target: trace.targetSummary.label,
            })),
            { json: false },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("runs")
      .description("List heartbeat runs associated with an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(apiPath`/api/issues/${issueId}/runs`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("live-runs")
      .description("List queued and running heartbeat runs associated with an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<HeartbeatRun[]>(apiPath`/api/issues/${issueId}/live-runs`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("active-run")
      .description("Show the active heartbeat run associated with an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const run = await ctx.api.get<HeartbeatRun | null>(apiPath`/api/issues/${issueId}/active-run`);
          printOutput(run, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:export")
      .description("Export feedback traces for an issue")
      .argument("<issueId>", "Issue ID")
      .option("--target-type <type>", "Filter by target type")
      .option("--vote <vote>", "Filter by vote value")
      .option("--status <status>", "Filter by trace status")
      .option("--from <iso8601>", "Only include traces created at or after this timestamp")
      .option("--to <iso8601>", "Only include traces created at or before this timestamp")
      .option("--shared-only", "Only include traces eligible for sharing/export")
      .option("--include-payload", "Include stored payload snapshots in the export")
      .option("--out <path>", "Write export to a file path instead of stdout")
      .option("--format <format>", "Export format: json or ndjson", "ndjson")
      .action(async (issueId: string, opts: IssueFeedbackOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const traces = (await ctx.api.get<FeedbackTrace[]>(
            `${apiPath`/api/issues/${issueId}/feedback-traces`}${buildFeedbackTraceQuery(opts, opts.includePayload ?? true)}`,
          )) ?? [];
            const serialized = serializeFeedbackTraces(traces, opts.format);
            if (opts.out?.trim()) {
              await writeFile(opts.out, serialized, "utf8");
              if (ctx.json) {
                printOutput(
                  { out: opts.out, count: traces.length, format: normalizeFeedbackTraceExportFormat(opts.format) },
                  { json: true },
                );
                return;
              }
              console.log(`Wrote ${traces.length} feedback trace(s) to ${opts.out}`);
            return;
          }
          process.stdout.write(`${serialized}${serialized.endsWith("\n") ? "" : "\n"}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("checkout")
      .description("Checkout issue for an agent")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--agent-id <id>", "Agent ID")
      .option(
        "--expected-statuses <csv>",
        "Expected current statuses",
        "todo,backlog,blocked",
      )
      .action(async (issueId: string, opts: IssueCheckoutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = checkoutIssueSchema.parse({
            agentId: opts.agentId,
            expectedStatuses: parseCsv(opts.expectedStatuses),
          });
          const updated = await ctx.api.post<Issue>(apiPath`/api/issues/${issueId}/checkout`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("release")
      .description("Release issue back to todo and clear assignee")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const updated = await ctx.api.post<Issue>(apiPath`/api/issues/${issueId}/release`, {});
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function addIssuePostDeleteMarkerCommand(
  issue: Command,
  name: string,
  description: string,
  method: "post" | "delete",
  pathSuffix: string,
): void {
  addCommonClientOptions(
    issue
      .command(name)
      .description(description)
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = method === "post"
            ? await ctx.api.post(`${apiPath`/api/issues/${issueId}`}${pathSuffix}`, {})
            : await ctx.api.delete(`${apiPath`/api/issues/${issueId}`}${pathSuffix}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

function parseHiddenAt(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "null") return null;
  return value;
}

function filterIssueRows(rows: Issue[], match: string | undefined): Issue[] {
  if (!match?.trim()) return rows;
  const needle = match.trim().toLowerCase();
  return rows.filter((row) => {
    const text = [row.identifier, row.title, row.description]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .toLowerCase();
    return text.includes(needle);
  });
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}

/** document:image 收的图片扩展名；服务端的类型白名单仍是最终裁判。 */
const IMAGE_FILE_EXTENSION_RE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * `document:put` 与 `document:image` 共用的写入路径：模板校验 → 认领 → 带
 * base-revision 缺失自修的 PUT。抽成一个函数，让追加图片和手写正文过
 * 完全相同的门禁，两条命令不会漂移。
 */
async function upsertIssueDocument(
  ctx: ResolvedClientContext,
  issueId: string,
  key: string,
  input: {
    title?: string;
    format?: string;
    body?: string;
    changeSummary?: string;
    baseRevisionId?: string;
  },
): Promise<unknown> {
  // 读卡提前到这里只为拿 identifier 补默认标题。它是 GET 不是认领，认领仍在
  // 模板校验之后，顺序没变。
  const existing = await ctx.api.get<Issue>(apiPath`/api/issues/${issueId}`).catch(() => null);
  const payload = upsertIssueDocumentSchema.parse({
    title: input.title?.trim() || defaultDocumentTitle(key, existing?.identifier) || undefined,
    format: input.format ?? "markdown",
    body: input.body,
    changeSummary: input.changeSummary,
    baseRevisionId: input.baseRevisionId,
  });
  const path = apiPath`/api/issues/${issueId}/documents/${key}`;
  // 模板校验排在认领之前：被拒的写入不该留下一次认领。
  if (key.trim().toLowerCase() === "decision-log") {
    // 上一版正文只为「只查这次动过的条目」而读：继承来的不合规条目不该
    // 挡住后来人。第一次建文档撞 404，当空串走全查。
    const prev = await ctx.api.get<{ body?: string }>(path).catch(() => null);
    const templateError = decisionLogTemplateError(prev?.body ?? "", payload.body ?? "");
    if (templateError) throw new Error(templateError);
  }
  // 认领门禁扩面 (MUL-443): writing a document is taking the card, so
  // the CLI takes it rather than making the caller discover the 409.
  if (existing) await autoClaimIfUnclaimed(ctx, existing);
  try {
    return await ctx.api.put(path, payload);
  } catch (err) {
    // 机械门禁自修 (MUL-453): "this document already exists, name the
    // revision you are editing" is a fact the CLI can look up, not a
    // decision the caller has to make, so it looks it up. The server
    // hands the current revision back in the rejection precisely so
    // this is possible.
    //
    // Only the missing-id case retries. A STALE id means somebody
    // else's revision landed in between, and blindly re-basing would
    // erase their edit — that one stays the caller's call.
    const revisionId = missingBaseRevisionId(err);
    if (!revisionId) throw err;
    return ctx.api.put(path, { ...payload, baseRevisionId: revisionId });
  }
}

async function uploadAttachment(
  apiBase: string,
  apiKey: string | undefined,
  input: { companyId: string; issueId: string; filePath: string; commentId?: string; runId?: string },
): Promise<unknown> {
  const bytes = await readFile(input.filePath);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: inferContentTypeFromPath(input.filePath) }), input.filePath.split(/[\\/]/).pop() ?? "attachment");
  if (input.commentId) form.set("issueCommentId", input.commentId);
  // This multipart upload uses a hand-rolled fetch rather than PaperclipApiClient,
  // so it must forward the agent run-id header itself — otherwise an
  // agent-authenticated upload is rejected with "401 Agent run id required"
  // (the client injects x-paperclip-run-id automatically for JSON requests).
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (input.runId) headers["x-paperclip-run-id"] = input.runId;
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/companies/${input.companyId}/issues/${input.issueId}/attachments`), {
    method: "POST",
    headers,
    body: form,
  });
  return parseFetchResponse(response);
}

async function downloadAttachment(
  apiBase: string,
  apiKey: string | undefined,
  attachmentId: string,
): Promise<Buffer> {
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/attachments/${attachmentId}/content`), {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) {
    await parseFetchResponse(response);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function parseFetchResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = text.trim() ? safeJson(text) : null;
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `Request failed with status ${response.status}`;
    throw new Error(`API error ${response.status}: ${message}`);
  }
  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
