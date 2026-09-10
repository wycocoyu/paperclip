import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { agents, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  createDecisionArchiveProposalSchema,
  decisionInputsSchema,
  decisionOptionsSchema,
  type AttentionArchiveManifestEntry,
  type AttentionArchiveTargetSnapshot,
  type AttentionItem,
  type CreateDecisionArchiveProposalInput,
  missingDecisionBodySections,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { decisionService, type DecisionServiceOptions } from "../services/decisions.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { attentionService } from "../services/attention.js";
import { authorizationDeniedDetails, authorizationService } from "../services/authorization.js";
import { canReadDecisionSource } from "../services/decision-queues.js";
import { loadIssueClaimState, unclaimedDeliverableDenial } from "../services/issue-claim-gate.js";
import { recordRequestParticipantSession } from "../services/issue-participant-sessions.js";
import { hashAttentionArchiveManifest } from "../services/decision-retention.js";
import { forbidden, unprocessable } from "../errors.js";

/**
 * 决策卡必填字段 (MUL-86, 老板令 2026-08-28): body must carry the three
 * template sections, and exactly one option must be the recommendation with a
 * non-empty reason. The CLI has enforced the same shape since MUL-49's
 * 收口; this is the server half so API-created decisions (agent proposals,
 * board backfills) cannot bypass it. Internal system proposals (attention
 * archive) file through svc.create directly and stay outside this gate.
 */
function decisionRequiredFieldError(body: { body: string; options: Array<{ recommendationReason?: string | null }> }): { code: string; message: string } | null {
  const missing = missingDecisionBodySections(body.body);
  if (missing.length > 0) {
    return {
      code: "decision_body_template_missing",
      message: `决策正文缺节：${missing.join("、")} —— 三段死模板（背景 / 判断标准 / 方案）缺一不可（MUL-86）`,
    };
  }
  const withReason = body.options.filter((option) =>
    typeof option.recommendationReason === "string" && option.recommendationReason.trim().length > 0);
  if (withReason.length === 0) {
    return {
      code: "decision_recommendation_missing",
      message: "决策必须带推荐：恰好一个选项要带非空 recommendationReason（CLI：--recommend + --recommend-reason）",
    };
  }
  if (withReason.length > 1) {
    return {
      code: "decision_recommendation_ambiguous",
      message: "只能有一个推荐选项：多个选项带了 recommendationReason",
    };
  }
  return null;
}

const createSchema = z.object({
  title: z.string().trim().min(1).max(500),
  body: z.string().max(100_000),
  ruleKey: z.string().trim().max(240).nullable().optional(),
  options: decisionOptionsSchema,
  inputs: decisionInputsSchema.nullable().optional(),
  expiresAt: z.coerce.date().optional(),
  idempotencyKey: z.string().trim().min(1).max(500).nullable().optional(),
  continuationPolicy: z.enum(["none", "wake_origin_agent"]).optional(),
  resolverPolicy: z.enum(["board", "agents"]).optional(),
  originIssueId: z.string().guid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // createdByAgentId: the mirror of actingAgentId on /decide. A terminal
  // operating the board has no agent identity on the request, so the create
  // path used to 403 it outright and back-filling an already-settled decision
  // had to borrow another session's run. The board names the agent the record
  // is attributed to instead; an agent actor still cannot claim to be another.
  createdByAgentId: z.string().guid().nullable().optional(),
}).strict();
// A bundle is always proposed by an agent actor, so its items never carry the
// board's explicit attribution field.
const bundleSchema = z.object({ title: z.string().trim().min(1).max(500), summary: z.string().max(100_000), decisions: z.array(createSchema.omit({ createdByAgentId: true })).min(1).max(50) }).strict();
// actingAgentId: a board-policy decision is the board's to make, but it is
// still performed from somewhere — a terminal agent operating the board. The
// two were collapsed into one field, so every such verdict read as an
// anonymous "local-board". Board-only: an agent must not claim to be another.
const decideSchema = z.object({ optionId: z.string().trim().min(1).max(120), inputValues: z.record(z.string(), z.string().max(20_000)).optional(), idempotencyKey: z.string().trim().min(1).max(500).nullable().optional(), actingAgentId: z.string().guid().nullable().optional() }).strict();
const dismissSchema = z.object({ reason: z.string().max(20_000).nullable().optional() }).strict();
const statsQuerySchema = z.object({
  groupBy: z.literal("ruleKey"),
  originAgentId: z.string().guid().optional(),
  since: z.coerce.date().optional(),
}).strict();

function agentContext(req: Parameters<typeof getActorInfo>[0]) {
  // runId is optional on purpose: a terminal agent holding a standard key has
  // no run, and requiring one meant it could never propose a decision. The
  // service derives provenance from originIssueId instead (user 2026-08-27).
  if (req.actor.type !== "agent" || !req.actor.agentId) return null;
  return { agentId: req.actor.agentId, runId: req.actor.runId ?? null };
}

function boardUserId(req: Parameters<typeof getActorInfo>[0]) {
  assertBoard(req);
  return req.actor.userId ?? "local-implicit-board";
}

// A board actor may name the agent a decision is attributed to, but only one of
// its own company's — otherwise the board could pin a record on any agent in
// the instance. Shared by the create and decide paths, which check the same thing.
function companyAgentId(db: Db, companyId: string, agentId: string) {
  return db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0]?.id ?? null);
}

export function decisionRoutes(db: Db, options: DecisionServiceOptions) {
  const router = Router();
  const svc = decisionService(db, options);

  /**
   * Sends the 认领门禁 denial when the origin card is unclaimed (MUL-443).
   * Returns true when the caller should stop — the response is already written.
   * The rule lives in services/issue-claim-gate.ts, shared with the document
   * write in routes/issues.ts so both stay the same rule.
   *
   * A missing or unknown originIssueId falls through: `decisions.originIssueId`
   * is a NOT NULL FK, so the service rejects it on its own and this gate has no
   * business inventing a second error for it.
   */
  async function denyUnclaimedDecision(
    req: Request,
    res: Response,
    companyId: string,
    originIssueId: string | null | undefined,
  ): Promise<boolean> {
    if (!originIssueId) return false;
    const issue = await loadIssueClaimState(db, companyId, originIssueId);
    if (!issue) return false;
    const denial = unclaimedDeliverableDenial({ actorType: req.actor.type, issue, deliverable: "decision" });
    if (!denial) return false;
    res.status(denial.status).json(denial.body);
    return true;
  }
  router.post(
    "/companies/:companyId/decision-archive-proposals",
    validate(createDecisionArchiveProposalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agent = agentContext(req);
      if (!agent) {
        res.status(403).json({ error: "Agent identity required" });
        return;
      }
      const access = await authorizationService(db).decide({
        actor: req.actor,
        action: "decision_triage:manage",
        resource: { type: "company", companyId },
      });
      if (!access.allowed) throw forbidden(access.explanation, authorizationDeniedDetails(access));

      const proposal = req.body as CreateDecisionArchiveProposalInput;
      const requested = new Map<string, CreateDecisionArchiveProposalInput["items"][number]>(proposal.items.map((item) => [
        `${item.sourceKind}:${item.sourceId}`,
        item,
      ]));
      const found = new Map<string, AttentionItem>();
      const snapshot = await db.transaction(async (tx) => attentionService(tx as unknown as Db).list(companyId, {
        includeDismissed: true,
        all: true,
        allowUnscopedAll: true,
      }), { isolationLevel: "repeatable read" });
      for (const item of snapshot.items) {
        const key = `${item.sourceKind}:${item.subject.id}`;
        if (requested.has(key)) found.set(key, item);
      }

      const manifest: AttentionArchiveManifestEntry[] = [];
      for (const [key, item] of [...requested.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const attentionItem = found.get(key);
        if (!attentionItem || !attentionItem.shelf || attentionItem.archivedAt) {
          throw unprocessable("Every archive proposal item must be on the current aging shelf");
        }
        if (!(await canReadDecisionSource(db, req.actor, companyId, attentionItem.sourceKind, attentionItem.subject.id))) {
          throw unprocessable("Every archive proposal item must be on the current aging shelf");
        }
        manifest.push({
          companyId,
          sourceKind: attentionItem.sourceKind,
          sourceId: attentionItem.subject.id,
          expectedVersion: attentionItem.retentionVersion,
          activityAt: attentionItem.activityAt,
          reason: item.reason,
        });
      }
      const manifestHash = hashAttentionArchiveManifest(manifest);
      const targetSnapshots = Object.fromEntries(manifest.map((entry) => [
        `attention:${entry.sourceKind}:${entry.sourceId}`,
        {
          status: "attention",
          assigneeAgentId: null,
          assigneeUserId: null,
          updatedAt: entry.activityAt,
          attentionArchive: entry,
        } satisfies AttentionArchiveTargetSnapshot,
      ]));
      const body = manifest.map((entry) => `- **${entry.sourceKind}:${entry.sourceId}** — ${entry.reason}`).join("\n");
      const created = await svc.create({
        companyId,
        actor: req.actor,
        ...agent,
        title: `Archive ${manifest.length} aging decision${manifest.length === 1 ? "" : "s"}?`,
        body,
        ruleKey: "attention.bulk_archive",
        idempotencyKey: proposal.idempotencyKey ?? `attention-archive:${manifestHash}:${agent.runId}`,
        continuationPolicy: "wake_origin_agent",
        options: [
          { id: "archive", label: "Archive reviewed items", style: "destructive", effects: [] },
          { id: "keep", label: "Keep items", effects: [] },
        ],
        metadata: { kind: "attention_archive_proposal", manifestHash },
        additionalTargetSnapshots: targetSnapshots,
      });
      res.status(201).json(created);
    },
  );
  router.post("/companies/:companyId/decisions", validate(createSchema), async (req, res) => {
    const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const { createdByAgentId, ...body } = req.body as z.infer<typeof createSchema>;
    const requiredFieldError = decisionRequiredFieldError(body);
    if (requiredFieldError) {
      res.status(422).json({ error: requiredFieldError.message, details: { code: requiredFieldError.code } });
      return;
    }
    const agent = agentContext(req);
    if (agent) {
      // 认领门禁扩面 (MUL-443): a decision is a deliverable, so opening one is
      // taking the card. Board callers below are exempt — they are already
      // accountable to a person.
      if (await denyUnclaimedDecision(req, res, companyId, body.originIssueId)) return;
      const created = await svc.create({ companyId, actor: req.actor, ...agent, ...body });
      // 开决策算参与，登记挂在来源卡上；没有来源卡的决策没有卡可登记。
      if (body.originIssueId) await recordRequestParticipantSession(db, req, body.originIssueId);
      res.status(201).json(created);
      return;
    }
    if (!createdByAgentId) {
      res.status(403).json({ error: "Agent identity required: authenticate as an agent, or pass createdByAgentId naming the company agent this decision is attributed to" });
      return;
    }
    assertBoard(req);
    const originAgentId = await companyAgentId(db, companyId, createdByAgentId);
    if (!originAgentId) { res.status(422).json({ error: "createdByAgentId does not belong to this company" }); return; }
    // The board owns the call, the named agent owns the record: the decision is
    // filed under that agent with no run, so provenance falls back to
    // originIssueId — which the service requires on this path.
    const createdOnBehalf = await svc.create({ companyId, actor: req.actor, agentId: originAgentId, runId: null, ...body });
    if (body.originIssueId) await recordRequestParticipantSession(db, req, body.originIssueId);
    res.status(201).json(createdOnBehalf);
  });
  router.post("/companies/:companyId/decision-bundles", validate(bundleSchema), async (req, res) => {
    const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const agent = agentContext(req); if (!agent) { res.status(403).json({ error: "Agent identity required" }); return; }
    for (const item of req.body.decisions as Array<{ title?: string; body: string; options: Array<{ recommendationReason?: string | null }> }>) {
      const itemError = decisionRequiredFieldError(item);
      if (itemError) {
        res.status(422).json({ error: itemError.message, details: { code: itemError.code, bundleItemTitle: item.title ?? null } });
        return;
      }
    }
    // The bundle loop gates every item: one unclaimed origin card is enough to
    // reject, because a partially-filed bundle is worse than none.
    for (const item of req.body.decisions as Array<{ originIssueId?: string | null }>) {
      if (await denyUnclaimedDecision(req, res, companyId, item.originIssueId)) return;
    }
    res.status(201).json(await svc.createBundle({ companyId, actor: req.actor, ...agent, ...req.body }));
  });
  // Readable by agents as well as the board: an agent picking up a task needs
  // to see what was already decided on it, and a decision is a record of what
  // the company agreed, not a private board artifact.
  router.get("/companies/:companyId/decisions", async (req, res) => {
    const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const query = z.object({ status: z.enum(["open", "decided", "expired", "cancelled"]).optional(), bundleId: z.string().guid().optional(), targetIssueId: z.string().guid().optional(), originIssueId: z.string().guid().optional(), originAgentId: z.string().guid().optional(), limit: z.coerce.number().int().positive().max(100).optional() }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid decision filters", details: query.error.flatten() }); return; }
    res.json(await svc.list(companyId, query.data));
  });
  /**
   * Gardener telemetry contract:
   * { groupBy: "ruleKey", filters: { originAgentId: string|null, since: ISO-8601|null },
   *   totals: { proposed, accepted, rejected, expired },
   *   groups: [{ ruleKey: string|null, proposed, accepted, rejected, expired,
   *     chosenOptions: [{ optionId, count }] }] }
   * Accepted means a non-dismissed decided outcome; rejected means an explicit dismiss;
   * chosenOptions counts accepted outcomes only; expired is separate, and cancelled
   * decisions contribute only to proposed.
   */
  router.get("/companies/:companyId/decisions/stats", async (req, res) => {
    const companyId = req.params.companyId as string; assertBoardOrAgent(req); assertCompanyAccess(req, companyId);
    const query = statsQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid decision stats filters", details: query.error.flatten() }); return; }
    if (req.actor.type === "agent" && query.data.originAgentId && query.data.originAgentId !== req.actor.agentId) {
      res.status(403).json({ error: "Agents may only read their own decision stats" }); return;
    }
    const originAgentId = req.actor.type === "agent" ? req.actor.agentId : query.data.originAgentId;
    res.json(await svc.stats(companyId, { originAgentId, since: query.data.since }));
  });
  router.get("/decisions/:id", async (req, res) => {
    assertBoardOrAgent(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Decision not found");
    if (!decision) return;
    if (req.actor.type === "agent" && req.actor.agentId !== decision.originAgentId) { res.status(403).json({ error: "Only the origin agent may read this decision" }); return; }
    res.json(await svc.outcome(decision.id));
  });
  router.post("/decisions/:id/decide", validate(decideSchema), async (req, res) => {
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Decision not found");
    if (!decision) return;
    if (req.actor.type === "agent" && req.actor.agentId && req.actor.companyId === decision.companyId) {
      // Any company agent may decide, whatever the resolverPolicy (user
      // 2026-08-27): the operator relays their verdicts through terminal
      // agents, so "board only" in practice meant "laundered through
      // local-board with the agent invisible". The verdict is signed by the
      // agent that performed it; resolverPolicy stays on the record as the
      // proposer's intent, not as a gate.
      res.json(await svc.decide({
        id: decision.id,
        decidedByAgentId: req.actor.agentId,
        decidedByRunId: req.actor.runId ?? null,
        userActor: req.actor,
        ...req.body,
      }));
      return;
    }
    const userId = boardUserId(req);
    const { actingAgentId, ...decideBody } = req.body as z.infer<typeof decideSchema>;
    // Record which terminal performed it alongside the board user who owns the
    // call, so the card reads "<board user> · via <agent>" instead of dropping
    // the operator. Same shape the issue list already uses for created-by.
    let actingAgent: string | null = null;
    if (actingAgentId) {
      actingAgent = await companyAgentId(db, decision.companyId, actingAgentId);
      if (!actingAgent) {
        res.status(422).json({ error: "actingAgentId does not belong to this company" });
        return;
      }
    }
    res.json(await svc.decide({
      id: decision.id,
      decidedByUserId: userId,
      decidedByAgentId: actingAgent ?? undefined,
      userActor: req.actor,
      ...decideBody,
    }));
  });
  router.post("/decisions/:id/dismiss", validate(dismissSchema), async (req, res) => {
    const userId = boardUserId(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Decision not found");
    if (!decision) return;
    res.json(await svc.dismiss(decision.id, userId, req.actor, req.body.reason));
  });
  router.post("/decisions/:id/cancel", async (req, res) => {
    assertBoardOrAgent(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Decision not found");
    if (!decision) return;
    const actor = getActorInfo(req); res.json(await svc.cancel(decision.id, { actorType: actor.actorType, actorId: actor.actorId, runId: actor.runId }));
  });
  router.delete("/decisions/:id", async (req, res) => {
    assertBoardOrAgent(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Decision not found");
    if (!decision) return;
    const actor = getActorInfo(req);
    res.json(await svc.remove(decision.id, { actorType: actor.actorType, actorId: actor.actorId, runId: actor.runId }));
  });
  return router;
}
