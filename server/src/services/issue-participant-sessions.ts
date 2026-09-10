import { and, asc, eq, sql } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { issueParticipantSessions } from "@paperclipai/db";
import type { IssueParticipantSession } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * 参与的 session (MUL-591)：登记「哪些终端会话对这张卡写过东西」。
 *
 * 判据是写过，不是「开工」——只改了卡内文档、只发过一条进度的会话同样算，
 * 而纯读不留痕。会话 id 随每个写请求的 X-Paperclip-Session 头进来，四条写
 * 路径各自在业务写入成功之后叫一次这里。
 */

/** 头里没有 session 是正常态（UI 写入、无 session 变量的终端），不是错误。 */
export function participantSessionIdFromRequest(req: Request): string | null {
  const raw = req.header("x-paperclip-session")?.trim();
  if (!raw) return null;
  // 与 reviewer_session 同一上限：id 是外部输入，长度不设限等于把日志和列表
  // 交给调用方决定。
  return raw.slice(0, 200);
}

export async function recordParticipantSession(
  db: Db,
  input: { issueId: string; sessionId: string; agentId?: string | null; source?: "auto" | "manual" },
): Promise<void> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return;
  const agentId = input.agentId ?? null;
  await db
    .insert(issueParticipantSessions)
    .values({ issueId: input.issueId, sessionId, agentId, source: input.source ?? "auto" })
    // 补写而不是覆盖：同一个 session 的第一次写入可能还没带上 agent（旧行、
    // 或经由没有 agent 身份的路径），后来的写入把它补齐；已经认出来的 agent
    // 不让后来者改名，否则一次匿名写入就能把归属抹掉。首次登记时间同理不动。
    .onConflictDoUpdate({
      target: [issueParticipantSessions.issueId, issueParticipantSessions.sessionId],
      set: { agentId },
      setWhere: sql`${issueParticipantSessions.agentId} is null`,
    });
}

/**
 * 写路径上的登记：拿不到 session 就跳过，登记失败只留日志。
 *
 * 参与记录是台账，不该让一条记不上的登记把已经落库的 progress / 文档 / 状态
 * 推进回滚成一次失败的请求。
 */
export async function recordRequestParticipantSession(
  db: Db,
  req: Request,
  issueId: string,
): Promise<void> {
  const sessionId = participantSessionIdFromRequest(req);
  if (!sessionId) return;
  // agent 不从调用点传：写请求已经被认证成某个 agent，身份就挂在 req 上，
  // 从这里取一次，新加的登记点漏传不了。
  const agentId = req.actor?.type === "agent" ? req.actor.agentId ?? null : null;
  try {
    await recordParticipantSession(db, { issueId, sessionId, agentId });
  } catch (err) {
    logger.warn({ err, issueId, sessionId }, "failed to record issue participant session");
  }
}

export async function listParticipantSessions(db: Db, issueId: string): Promise<IssueParticipantSession[]> {
  const rows = await db
    .select()
    .from(issueParticipantSessions)
    .where(eq(issueParticipantSessions.issueId, issueId))
    .orderBy(asc(issueParticipantSessions.firstSeenAt));
  return rows.map((row) => ({
    issueId: row.issueId,
    sessionId: row.sessionId,
    agentId: row.agentId ?? null,
    firstSeenAt: row.firstSeenAt,
    source: row.source === "manual" ? "manual" : "auto",
  }));
}

export async function removeParticipantSession(db: Db, issueId: string, sessionId: string): Promise<boolean> {
  const removed = await db
    .delete(issueParticipantSessions)
    .where(and(
      eq(issueParticipantSessions.issueId, issueId),
      eq(issueParticipantSessions.sessionId, sessionId),
    ))
    .returning({ sessionId: issueParticipantSessions.sessionId });
  return removed.length > 0;
}
