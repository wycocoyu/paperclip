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

const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 1_000;
const RETRY_CEILING_MS = 30_000;

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
const pending = new Map<string, SkillVersionPublishedEvent>();
const attempts = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const failures = new Map<string, {
  event: SkillVersionPublishedEvent;
  error: string;
  at: string;
  attempts: number;
}>();
let draining = false;

export function configureSkillFanout(next: SkillsTeamProjection | null): void {
  projection = next;
}

/**
 * Test seam mirroring resetWorkspaceRuntimeControlStateForTests: the
 * coordinator owns process-wide state, tests own its lifetime.
 */
export function resetSkillFanoutForTests(): void {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  pending.clear();
  attempts.clear();
  failures.clear();
  draining = false;
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
  return [...failures.values()]
    .filter((entry) => !companyId || entry.event.companyId === companyId)
    .map((entry) => ({
      companyId: entry.event.companyId,
      skillId: entry.event.skillId,
      lastError: entry.error,
      attempts: entry.attempts,
      lastAttemptAt: entry.at,
    }));
}

function taskKey(event: SkillVersionPublishedEvent): string {
  return `${event.companyId}/${event.skillId}`;
}

/**
 * Hand a committed version to the coordinator. Never throws and never awaits:
 * callers are on a request path that has already committed, so a fan-out
 * problem must not turn into a failed write.
 */
export function publishSkillVersionPublished(db: Db, event: SkillVersionPublishedEvent): void {
  if (!projection || projection.companyId !== event.companyId) return;
  const key = taskKey(event);
  const timer = retryTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(key);
  }
  // Newest wins: a skill published three times in a row is projected once.
  pending.set(key, event);
  attempts.delete(key);
  void drain(db);
}

async function drain(db: Db): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const next = pending.entries().next();
      if (next.done) return;
      const [key, event] = next.value;
      pending.delete(key);
      try {
        await deliver(db, event);
        attempts.delete(key);
        failures.delete(key);
      } catch (err) {
        recordFailure(db, key, event, err);
      }
    }
  } finally {
    draining = false;
  }
}

function recordFailure(db: Db, key: string, event: SkillVersionPublishedEvent, err: unknown): void {
  // Lock contention is a peer doing the same idempotent work, not a failed
  // attempt: it waits out the backoff without spending the retry budget, so a
  // long CLI pull next to a busy server cannot exhaust it.
  const lockBusy = err instanceof SkillsPullLockBusyError;
  const attempt = lockBusy ? (attempts.get(key) ?? 0) : (attempts.get(key) ?? 0) + 1;
  if (!lockBusy) attempts.set(key, attempt);
  const error = err instanceof Error ? err.message : String(err);
  if (!lockBusy && attempt >= MAX_ATTEMPTS) {
    attempts.delete(key);
    failures.set(key, { event, error, at: new Date().toISOString(), attempts: attempt });
    logger.error({ err, key, attempts: attempt, ...event }, "skill fan-out gave up after retries");
    return;
  }
  if (lockBusy) {
    logger.info({ key, ...event }, "skill fan-out deferred: skills pull lock is busy");
  } else {
    logger.warn({ err, key, attempt, ...event }, "skill fan-out failed; retrying");
  }
  const delayMs = Math.min(RETRY_BASE_MS * 2 ** (Math.max(attempt, 1) - 1), RETRY_CEILING_MS);
  const timer = setTimeout(() => {
    retryTimers.delete(key);
    // A publish that arrived during the backoff already supersedes this event.
    if (!pending.has(key)) pending.set(key, event);
    void drain(db);
  }, delayMs);
  timer.unref?.();
  retryTimers.set(key, timer);
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
