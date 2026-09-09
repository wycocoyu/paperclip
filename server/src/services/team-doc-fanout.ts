import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamDocFanoutWatermarks, teamRuleNotes, teamWikiPages } from "@paperclipai/db";
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
  /**
   * Which save triggered this, for the log only. Both are absent on the startup
   * sweep, which knows the company is behind but not which save the previous
   * process died holding.
   */
  noteId?: string;
  versionId?: string;
}

export interface TeamWikiVersionPublishedEvent {
  companyId: string;
  pageId: string;
  versionId?: string;
}

type TeamDocEvent =
  | ({ kind: "rules" } & TeamRuleVersionPublishedEvent)
  | ({ kind: "wiki" } & TeamWikiVersionPublishedEvent);

/** Every note in the company, in the order the Team Rules tab shows them. */
export interface TeamRulesSnapshot {
  companyId: string;
  notes: readonly { title: string; body: string }[];
}

/**
 * Where one page's projection lives, with no bytes attached — enough to address
 * a file a sink already wrote, which is what retiring an old copy needs.
 */
export interface TeamWikiPageRef {
  companyId: string;
  pageId: string;
  space: string;
  path: string;
}

export interface TeamWikiPageSnapshot extends TeamWikiPageRef {
  title: string;
  body: string;
}

/** One place a committed Rules/Wiki revision gets projected to. */
export interface TeamDocFanoutSink {
  name: string;
  /** Returns a short status for the log; throws to request a retry. */
  deliverRules(snapshot: TeamRulesSnapshot, projection: TeamDocProjection): Promise<string>;
  deliverWikiPage(snapshot: TeamWikiPageSnapshot, projection: TeamDocProjection): Promise<string>;
  /**
   * Take back what an earlier `deliverWikiPage` put there, because the page was
   * renamed, archived or deleted. Idempotent — a copy that is already gone is a
   * success — and throws for anything else, so a failed removal sends the task
   * back through the retry instead of advancing the watermark past it.
   */
  retireWikiPage(previous: TeamWikiPageRef, projection: TeamDocProjection): Promise<string>;
}

const sinks: TeamDocFanoutSink[] = [openVikingSink];

let projection: TeamDocProjection | null = null;

const queue = createFanoutQueue<Db, TeamDocEvent>({
  keyOf: (event) => `${event.companyId}/${scopeOf(event)}`,
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

/**
 * The delivery unit, and the watermark key that records it. Rules render as one
 * company-wide pair of documents, so every note edit coalesces onto a single
 * task; wiki pages are independent files.
 */
function scopeOf(event: TeamDocEvent): string {
  return event.kind === "rules" ? "rules" : `wiki/${event.pageId}`;
}

/** One terminal fan-out failure, as the read-only failures route reports it. */
export interface TeamDocFanoutFailure {
  companyId: string;
  kind: "rules" | "wiki";
  /** Null on the startup sweep's rules task, which has no triggering note. */
  entityId: string | null;
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
      entityId: entry.event.kind === "rules" ? entry.event.noteId ?? null : entry.event.pageId,
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
    await recordDelivered(db, event.companyId, scopeOf(event), fingerprintRules(snapshot), null);
    return;
  }
  // What the last successful push addressed. The page row cannot say: on a
  // rename it already holds the new path, and on a delete it is gone.
  const previous = await loadDeliveredWikiRef(db, event.companyId, event.pageId);
  const snapshot = await loadWikiSnapshot(db, event);
  // Archived or deleted. The copy has to go rather than sit there: OpenViking
  // recall has no exclude filter, so a retired page left in the store keeps
  // answering queries, and a recalled wrong answer is worse than none —
  // nothing in it tells the reader to keep looking.
  if (!snapshot) {
    if (previous) await retire(previous, active);
    await clearDelivered(db, event.companyId, scopeOf(event));
    return;
  }
  for (const sink of sinks) {
    const status = await sink.deliverWikiPage(snapshot, active);
    logger.debug({ sink: sink.name, status, ...event }, "team doc fan-out delivered");
  }
  // Renamed: the new copy is written first, so a crash in between leaves a
  // duplicate the next run removes rather than a live page with no file.
  if (previous && (previous.space !== snapshot.space || previous.path !== snapshot.path)) {
    await retire(previous, active);
  }
  await recordDelivered(db, event.companyId, scopeOf(event), fingerprintWikiPage(snapshot), snapshot);
}

/** Throws on to the queue's retry, which is what keeps the watermark behind. */
async function retire(previous: TeamWikiPageRef, active: TeamDocProjection): Promise<void> {
  for (const sink of sinks) {
    const status = await sink.retireWikiPage(previous, active);
    logger.debug({ sink: sink.name, status, ...previous }, "team doc fan-out retired");
  }
}

/**
 * Only reached once every sink returned, so a watermark can never claim a
 * delivery that did not happen — a sink that throws sends the whole task back
 * through the queue's retry with the watermark still on the previous value.
 */
async function recordDelivered(
  db: Db,
  companyId: string,
  scope: string,
  contentHash: string,
  locator: TeamWikiPageRef | null,
): Promise<void> {
  const deliveredAt = new Date();
  const deliveredSpace = locator?.space ?? null;
  const deliveredPath = locator?.path ?? null;
  await db
    .insert(teamDocFanoutWatermarks)
    .values({ companyId, scope, contentHash, deliveredSpace, deliveredPath, deliveredAt })
    .onConflictDoUpdate({
      target: [teamDocFanoutWatermarks.companyId, teamDocFanoutWatermarks.scope],
      set: { contentHash, deliveredSpace, deliveredPath, deliveredAt },
    });
}

/**
 * Where the last successful push for this page landed, or null when there has
 * been none — including a watermark written before the locator columns existed,
 * whose file the next delivery re-addresses and records.
 */
async function loadDeliveredWikiRef(db: Db, companyId: string, pageId: string): Promise<TeamWikiPageRef | null> {
  const row = await db
    .select({ space: teamDocFanoutWatermarks.deliveredSpace, path: teamDocFanoutWatermarks.deliveredPath })
    .from(teamDocFanoutWatermarks)
    .where(and(
      eq(teamDocFanoutWatermarks.companyId, companyId),
      eq(teamDocFanoutWatermarks.scope, `wiki/${pageId}`),
    ))
    .then((rows) => rows[0] ?? null);
  if (!row?.space || !row.path) return null;
  return { companyId, pageId, space: row.space, path: row.path };
}

async function clearDelivered(db: Db, companyId: string, scope: string): Promise<void> {
  await db
    .delete(teamDocFanoutWatermarks)
    .where(and(
      eq(teamDocFanoutWatermarks.companyId, companyId),
      eq(teamDocFanoutWatermarks.scope, scope),
    ));
}

/**
 * Length-prefixed so a title that ends where the next field begins cannot
 * produce the digest of a genuinely different snapshot.
 */
function fingerprint(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${Buffer.byteLength(part, "utf8")}\n${part}`);
  return hash.digest("hex");
}

// Fingerprints cover the snapshot, not the rendered bytes: the snapshot is what
// a restart can re-read, and it is shared by every sink. A renderer change is a
// deploy, not drift, and does not have to be caught here.
function fingerprintRules(snapshot: TeamRulesSnapshot): string {
  return fingerprint(snapshot.notes.flatMap((note) => [note.title, note.body ?? ""]));
}

/**
 * Bump when the rendered file's shape changes, not its content: the fingerprint
 * is what decides whether a page is re-delivered, so a page nobody edits would
 * otherwise keep the old rendering forever. v2 added the `> id:` line.
 */
const WIKI_RENDER_VERSION = "v2";

function fingerprintWikiPage(snapshot: TeamWikiPageSnapshot): string {
  return fingerprint([WIKI_RENDER_VERSION, snapshot.space, snapshot.path, snapshot.title, snapshot.body ?? ""]);
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

/**
 * Covers the process that died between commit and fan-out — acceptance
 * criterion 7 of the MUL-559 proposal, and the hard prerequisite for retiring
 * the ov-sync hook.
 *
 * Compares each delivery unit's current snapshot against the watermark the last
 * successful push left behind and queues only the ones that disagree, so a
 * steady state costs two queries and no OpenViking traffic. The first boot after
 * this ships has no watermarks yet and therefore pushes everything once.
 *
 * What it cannot see is drift on OpenViking's own side: the watermark records
 * what we sent, not what the store still holds, so a file edited inside
 * OpenViking looks up to date here. Reading every URI back would cost one
 * `ov read` per file on every boot, which is not worth it for a store nobody
 * edits by hand.
 */
export async function reconcileTeamDocFanoutOnStartup(
  db: Db,
): Promise<{ scanned: number; queued: number; upToDate: number }> {
  const active = projection;
  if (!active) return { scanned: 0, queued: 0, upToDate: 0 };

  const marks = new Map(
    (await db
      .select({ scope: teamDocFanoutWatermarks.scope, contentHash: teamDocFanoutWatermarks.contentHash })
      .from(teamDocFanoutWatermarks)
      .where(eq(teamDocFanoutWatermarks.companyId, active.companyId)))
      .map((row) => [row.scope, row.contentHash] as const),
  );

  let scanned = 0;
  let queued = 0;
  let upToDate = 0;

  // A company with no notes renders no rules document, so there is nothing to
  // be behind on and nothing to queue.
  const rules = await loadRulesSnapshot(db, active.companyId);
  if (rules.notes.length > 0) {
    scanned += 1;
    if (marks.get("rules") === fingerprintRules(rules)) upToDate += 1;
    else {
      queue.publish(db, { kind: "rules", companyId: active.companyId });
      queued += 1;
    }
  }

  const pages = await db
    .select({
      id: teamWikiPages.id,
      companyId: teamWikiPages.companyId,
      space: teamWikiPages.space,
      path: teamWikiPages.path,
      title: teamWikiPages.title,
      body: teamWikiPages.body,
    })
    .from(teamWikiPages)
    .where(and(eq(teamWikiPages.companyId, active.companyId), isNull(teamWikiPages.archivedAt)));

  for (const page of pages) {
    scanned += 1;
    const snapshot: TeamWikiPageSnapshot = {
      companyId: page.companyId,
      pageId: page.id,
      space: page.space,
      path: page.path,
      title: page.title,
      body: page.body,
    };
    if (marks.get(`wiki/${page.id}`) === fingerprintWikiPage(snapshot)) {
      upToDate += 1;
      continue;
    }
    queue.publish(db, { kind: "wiki", companyId: active.companyId, pageId: page.id });
    queued += 1;
  }

  // A page archived or deleted while this process was down fires no event, and
  // the loop above only walks live pages — so its watermark is the only thing
  // left that remembers OpenViking still holds a file for it. Queueing the
  // scope runs the same delivery an archive would have: no snapshot, retire,
  // drop the watermark.
  const live = new Set(pages.map((page) => `wiki/${page.id}`));
  for (const scope of marks.keys()) {
    if (!scope.startsWith("wiki/") || live.has(scope)) continue;
    scanned += 1;
    queued += 1;
    queue.publish(db, { kind: "wiki", companyId: active.companyId, pageId: scope.slice("wiki/".length) });
  }

  return { scanned, queued, upToDate };
}
