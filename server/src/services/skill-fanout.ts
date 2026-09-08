import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkillVersions, companySkills } from "@paperclipai/db";
import {
  EmptySkillSnapshotError,
  acquireSkillsPullLock,
  materializeSkill,
  readSidecar,
  sidecarMatchesRemoteMarkers,
  skillsPullLockPath,
  type SkillSnapshotFile,
} from "@paperclipai/skill-materializer";
import type { SkillsTeamProjection } from "../config.js";
import { logger } from "../middleware/logger.js";
import { createFanoutQueue } from "./fanout-queue.js";

/**
 * The one fact worth reacting to: a skill has a new current version committed.
 * `versionId` is the version that triggered the run and is carried for logging
 * only — delivery always projects whatever `currentVersionId` reads at that
 * moment, so a burst of publishes that collapses into one run cannot leave the
 * newest change markers sitting on older bytes.
 */
export interface SkillVersionPublishedEvent {
  companyId: string;
  skillId: string;
  versionId: string;
}

export interface SkillFanoutSnapshot {
  skillId: string;
  companyId: string;
  key: string;
  slug: string;
  currentVersionId: string;
  updatedAt: Date;
  files: readonly SkillSnapshotFile[];
}

/** One place a committed skill version gets projected to. */
export interface SkillFanoutSink {
  name: string;
  /** Returns a short status for the log; throws to request a retry. */
  deliver(snapshot: SkillFanoutSnapshot, projection: SkillsTeamProjection): Promise<string>;
}

// A lost lock means a peer is mid-write, not that the work is done: the CLI can
// exit quietly on contention because both sides pull the same bytes, but the
// server may be carrying a newer version than the pull it collided with.
class SkillsPullLockBusyError extends Error {
  constructor() {
    super("skills pull lock is held by another process");
    this.name = "SkillsPullLockBusyError";
  }
}

/**
 * The target directory carries local changes the server must not overwrite.
 * Surfaced as a (terminal) failure rather than a quiet skip: a skip would leave
 * the newest committed version stranded on a directory nobody is watching.
 */
export class SkillFanoutDriftError extends Error {
  constructor(
    readonly status: "skipped-foreign" | "skipped-local-modified",
    readonly note: string | null,
    readonly slug: string,
  ) {
    super(
      `skills-team directory "${slug}" has local changes that were not overwritten (${status}` +
        (note ? `: ${note}` : "") +
        "); after confirming the local changes can be discarded, use --force or delete the target directory and re-pull",
    );
    this.name = "SkillFanoutDriftError";
  }
}

const teamDirSink: SkillFanoutSink = {
  name: "skills-team",
  async deliver(snapshot, projection) {
    const lock = await acquireSkillsPullLock(skillsPullLockPath());
    if (!lock) throw new SkillsPullLockBusyError();
    try {
      // requireFile is deliberately not set: the CLI pull materializes
      // whatever the snapshot carries and skips only on an empty snapshot
      // (cli/src/commands/client/skill-materialize.ts), and the server-side
      // projection must not hold itself to a stricter bar than that.
      const result = await materializeSkill({
        skillId: snapshot.skillId,
        targetDir: path.join(projection.dir, snapshot.slug),
        files: snapshot.files,
        sidecar: {
          key: snapshot.key,
          currentVersionId: snapshot.currentVersionId,
          updatedAt: snapshot.updatedAt,
        },
      });
      if (result.status === "skipped-foreign" || result.status === "skipped-local-modified") {
        throw new SkillFanoutDriftError(result.status, result.note ?? null, snapshot.slug);
      }
      return result.note ? `${result.status} (${result.note})` : result.status;
    } catch (err) {
      // A snapshot with no files is what plugin-managed and empty skills look
      // like. Retrying cannot conjure them, so it is a skip, not a failure.
      if (err instanceof EmptySkillSnapshotError) {
        return "skipped-no-files";
      }
      throw err;
    } finally {
      await lock.release();
    }
  },
};

// The OpenViking sink lands here as a second entry; nothing else has to change.
const sinks: SkillFanoutSink[] = [teamDirSink];

let projection: SkillsTeamProjection | null = null;

const queue = createFanoutQueue<Db, SkillVersionPublishedEvent>({
  keyOf: (event) => `${event.companyId}/${event.skillId}`,
  deliver,
  isDeferrable: (err) => err instanceof SkillsPullLockBusyError,
  onDeferred: (event, key) => {
    logger.info({ key, ...event }, "skill fan-out deferred: skills pull lock is busy");
  },
  onRetry: (event, key, err, attempt) => {
    logger.warn({ err, key, attempt, ...event }, "skill fan-out failed; retrying");
  },
  onGaveUp: (event, key, err, attempts) => {
    logger.error({ err, key, attempts, ...event }, "skill fan-out gave up after retries");
  },
});

export function configureSkillFanout(next: SkillsTeamProjection | null): void {
  projection = next;
}

/** Where fan-out projects, for read-only callers that need the same checkout. */
export function skillFanoutProjection(): SkillsTeamProjection | null {
  return projection;
}

/**
 * Test seam mirroring resetWorkspaceRuntimeControlStateForTests: the
 * coordinator owns process-wide state, tests own its lifetime.
 */
export function resetSkillFanoutForTests(): void {
  queue.reset();
  projection = null;
}

/** One terminal fan-out failure, as the read-only failures route reports it. */
export interface SkillFanoutFailure {
  companyId: string;
  skillId: string;
  lastError: string;
  attempts: number;
  lastAttemptAt: string;
}

/**
 * Parked events: every one of these was logged at error level when it landed.
 * Filtered to one company when the failures route asks for it.
 */
export function skillFanoutFailures(companyId?: string): SkillFanoutFailure[] {
  return queue
    .failures()
    .filter((entry) => !companyId || entry.event.companyId === companyId)
    .map((entry) => ({
      companyId: entry.event.companyId,
      skillId: entry.event.skillId,
      lastError: entry.error,
      attempts: entry.attempts,
      lastAttemptAt: entry.at,
    }));
}

/**
 * Hand a committed version to the coordinator. Never throws and never awaits:
 * callers are on a request path that has already committed, so a fan-out
 * problem must not turn into a failed write.
 */
export function publishSkillVersionPublished(db: Db, event: SkillVersionPublishedEvent): void {
  if (!projection || projection.companyId !== event.companyId) return;
  queue.publish(db, event);
}

async function deliver(db: Db, event: SkillVersionPublishedEvent): Promise<void> {
  const active = projection;
  if (!active) return;
  const snapshot = await loadSnapshot(db, event);
  // A skill deleted between commit and delivery has nothing left to project;
  // removing its directory is `skills pull --prune-apply`'s job, not ours.
  if (!snapshot) return;
  for (const sink of sinks) {
    const status = await sink.deliver(snapshot, active);
    logger.debug({ sink: sink.name, status, slug: snapshot.slug, ...event }, "skill fan-out delivered");
  }
}

async function loadSnapshot(
  db: Db,
  event: SkillVersionPublishedEvent,
): Promise<SkillFanoutSnapshot | null> {
  const skill = await db
    .select({
      id: companySkills.id,
      companyId: companySkills.companyId,
      key: companySkills.key,
      slug: companySkills.slug,
      currentVersionId: companySkills.currentVersionId,
      updatedAt: companySkills.updatedAt,
    })
    .from(companySkills)
    .where(and(eq(companySkills.id, event.skillId), eq(companySkills.companyId, event.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!skill?.currentVersionId) return null;

  const version = await db
    .select({ fileInventory: companySkillVersions.fileInventory })
    .from(companySkillVersions)
    .where(and(
      eq(companySkillVersions.id, skill.currentVersionId),
      eq(companySkillVersions.companyId, event.companyId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!version) return null;

  return {
    skillId: skill.id,
    companyId: skill.companyId,
    key: skill.key,
    slug: skill.slug,
    currentVersionId: skill.currentVersionId,
    updatedAt: skill.updatedAt,
    files: version.fileInventory,
  };
}

/**
 * Covers the process that died between commit and fan-out. Compares each
 * skill's change markers against the sidecar already on disk and only queues
 * the ones that disagree, so a steady state costs one query and no version
 * loads.
 */
export async function reconcileSkillFanoutOnStartup(
  db: Db,
): Promise<{ scanned: number; queued: number; upToDate: number }> {
  const active = projection;
  if (!active) return { scanned: 0, queued: 0, upToDate: 0 };
  const skills = await db
    .select({
      id: companySkills.id,
      companyId: companySkills.companyId,
      key: companySkills.key,
      slug: companySkills.slug,
      currentVersionId: companySkills.currentVersionId,
      updatedAt: companySkills.updatedAt,
    })
    .from(companySkills)
    .where(eq(companySkills.companyId, active.companyId));

  let queued = 0;
  let upToDate = 0;
  for (const skill of skills) {
    if (!skill.currentVersionId) continue;
    const sidecar = await readSidecar(path.join(active.dir, skill.slug));
    if (sidecarMatchesRemoteMarkers(sidecar, {
      skillId: skill.id,
      key: skill.key,
      currentVersionId: skill.currentVersionId,
      updatedAt: skill.updatedAt,
    })) {
      upToDate += 1;
      continue;
    }
    publishSkillVersionPublished(db, {
      companyId: skill.companyId,
      skillId: skill.id,
      versionId: skill.currentVersionId,
    });
    queued += 1;
  }
  return { scanned: skills.length, queued, upToDate };
}
