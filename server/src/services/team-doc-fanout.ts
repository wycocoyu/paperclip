import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamRuleNotes, teamWikiPages } from "@paperclipai/db";
import type { TeamDocProjection } from "../config.js";
import { logger } from "../middleware/logger.js";
import { createFanoutQueue } from "./fanout-queue.js";
import { openVikingSink } from "./team-doc-ov-sink.js";

/**
 * MUL-559 step 4: the same "committed write → automatic delivery" path the
 * skills fan-out runs, for Team Rules and Team Wiki, with OpenViking
 * downstream.
 *
 * As with skills, `versionId` rides along for logging only — delivery always
 * reads whatever the row holds at that moment, so a burst of saves that
 * collapses into one run cannot deliver stale bytes under a fresh marker.
 */
export interface TeamRuleVersionPublishedEvent {
  companyId: string;
  noteId: string;
  versionId: string;
}

export interface TeamWikiVersionPublishedEvent {
  companyId: string;
  pageId: string;
  versionId: string;
}

type TeamDocEvent =
  | ({ kind: "rules" } & TeamRuleVersionPublishedEvent)
  | ({ kind: "wiki" } & TeamWikiVersionPublishedEvent);

/** Every note in the company, in the order the Team Rules tab shows them. */
export interface TeamRulesSnapshot {
  companyId: string;
  notes: readonly { title: string; body: string }[];
}

export interface TeamWikiPageSnapshot {
  companyId: string;
  pageId: string;
  space: string;
  path: string;
  title: string;
  body: string;
}

/** One place a committed Rules/Wiki revision gets projected to. */
export interface TeamDocFanoutSink {
  name: string;
  /** Returns a short status for the log; throws to request a retry. */
  deliverRules(snapshot: TeamRulesSnapshot, projection: TeamDocProjection): Promise<string>;
  deliverWikiPage(snapshot: TeamWikiPageSnapshot, projection: TeamDocProjection): Promise<string>;
}

const sinks: TeamDocFanoutSink[] = [openVikingSink];

let projection: TeamDocProjection | null = null;

const queue = createFanoutQueue<Db, TeamDocEvent>({
  // Rules render as one company-wide pair of documents, so every note edit
  // coalesces onto a single task; wiki pages are independent files.
  keyOf: (event) =>
    event.kind === "rules" ? `${event.companyId}/rules` : `${event.companyId}/wiki/${event.pageId}`,
  deliver,
  onRetry: (event, key, err, attempt) => {
    logger.warn({ err, key, attempt, ...event }, "team doc fan-out failed; retrying");
  },
  onGaveUp: (event, key, err, attempts) => {
    logger.error({ err, key, attempts, ...event }, "team doc fan-out gave up after retries");
  },
});

export function configureTeamDocFanout(next: TeamDocProjection | null): void {
  projection = next;
}

/** Test seam: the coordinator owns process-wide state, tests own its lifetime. */
export function resetTeamDocFanoutForTests(): void {
  queue.reset();
  projection = null;
}

export function setTeamDocFanoutSinksForTests(next: TeamDocFanoutSink[]): void {
  sinks.splice(0, sinks.length, ...next);
}

/** One terminal fan-out failure, as the read-only failures route reports it. */
export interface TeamDocFanoutFailure {
  companyId: string;
  kind: "rules" | "wiki";
  entityId: string;
  lastError: string;
  attempts: number;
  lastAttemptAt: string;
}

export function teamDocFanoutFailures(companyId?: string): TeamDocFanoutFailure[] {
  return queue
    .failures()
    .filter((entry) => !companyId || entry.event.companyId === companyId)
    .map((entry) => ({
      companyId: entry.event.companyId,
      kind: entry.event.kind,
      entityId: entry.event.kind === "rules" ? entry.event.noteId : entry.event.pageId,
      lastError: entry.error,
      attempts: entry.attempts,
      lastAttemptAt: entry.at,
    }));
}

/**
 * Hand a committed revision to the coordinator. Never throws and never awaits:
 * callers are on a request path that has already committed, so a fan-out
 * problem must not turn into a failed write.
 */
export function publishTeamRuleVersionPublished(db: Db, event: TeamRuleVersionPublishedEvent): void {
  if (!projection || projection.companyId !== event.companyId) return;
  queue.publish(db, { kind: "rules", ...event });
}

export function publishTeamWikiVersionPublished(db: Db, event: TeamWikiVersionPublishedEvent): void {
  if (!projection || projection.companyId !== event.companyId) return;
  queue.publish(db, { kind: "wiki", ...event });
}

async function deliver(db: Db, event: TeamDocEvent): Promise<void> {
  const active = projection;
  if (!active) return;
  if (event.kind === "rules") {
    const snapshot = await loadRulesSnapshot(db, event.companyId);
    for (const sink of sinks) {
      const status = await sink.deliverRules(snapshot, active);
      logger.debug({ sink: sink.name, status, ...event }, "team doc fan-out delivered");
    }
    return;
  }
  const snapshot = await loadWikiSnapshot(db, event);
  // A page deleted or archived between commit and delivery has nothing left to
  // project; retiring its OpenViking file is not this path's job.
  if (!snapshot) return;
  for (const sink of sinks) {
    const status = await sink.deliverWikiPage(snapshot, active);
    logger.debug({ sink: sink.name, status, ...event }, "team doc fan-out delivered");
  }
}

async function loadRulesSnapshot(db: Db, companyId: string): Promise<TeamRulesSnapshot> {
  // Same order as GET /team-rules/notes: the rendered document concatenates
  // note bodies, so a different order here would produce a different file.
  const notes = await db
    .select({ title: teamRuleNotes.title, body: teamRuleNotes.body })
    .from(teamRuleNotes)
    .where(eq(teamRuleNotes.companyId, companyId))
    .orderBy(asc(teamRuleNotes.position), asc(teamRuleNotes.createdAt));
  return { companyId, notes };
}

async function loadWikiSnapshot(
  db: Db,
  event: TeamWikiVersionPublishedEvent,
): Promise<TeamWikiPageSnapshot | null> {
  const page = await db
    .select({
      id: teamWikiPages.id,
      companyId: teamWikiPages.companyId,
      space: teamWikiPages.space,
      path: teamWikiPages.path,
      title: teamWikiPages.title,
      body: teamWikiPages.body,
    })
    .from(teamWikiPages)
    .where(and(
      eq(teamWikiPages.id, event.pageId),
      eq(teamWikiPages.companyId, event.companyId),
      isNull(teamWikiPages.archivedAt),
    ))
    .then((rows) => rows[0] ?? null);
  if (!page) return null;
  return {
    companyId: page.companyId,
    pageId: page.id,
    space: page.space,
    path: page.path,
    title: page.title,
    body: page.body,
  };
}
