import { resolvePaperclipHomeDir } from "@paperclipai/shared/home-paths";
import fs from "node:fs/promises";
import path from "node:path";

const SKILLS_PULL_LOCK_BASENAME = "skills-pull.lock";
// A full pull settles in seconds, so anything older than this is a crashed run
// whose pid may already have been recycled onto an unrelated process.
const SKILLS_PULL_LOCK_STALE_MS = 10 * 60_000;

export interface SkillsPullLock {
  release(): Promise<void>;
}

// The server writes the same skill directories the CLI does, so both processes
// have to agree on this one path or the lock protects nothing.
export function skillsPullLockPath(homeOverride?: string): string {
  return path.join(resolvePaperclipHomeDir(homeOverride), SKILLS_PULL_LOCK_BASENAME);
}

// Whoever holds the lock is doing the exact same idempotent work, so a loser
// exits quietly instead of waiting — pull runs from editor hooks that must not
// stall on a peer session.
export async function acquireSkillsPullLock(lockPath: string): Promise<SkillsPullLock | null> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.close();
      return {
        release: async () => {
          await fs.rm(lockPath, { force: true }).catch(() => {});
        },
      };
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : null;
      if (code !== "EEXIST") throw err;
      if (!(await removeStaleSkillsPullLock(lockPath))) return null;
    }
  }
  return null;
}

async function removeStaleSkillsPullLock(lockPath: string): Promise<boolean> {
  let stale = false;
  try {
    const raw = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown; createdAt?: unknown };
    const pid = typeof raw.pid === "number" ? raw.pid : 0;
    const createdAt = typeof raw.createdAt === "string" ? Date.parse(raw.createdAt) : Number.NaN;
    const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : SKILLS_PULL_LOCK_STALE_MS + 1;
    stale = !isPidAlive(pid) || ageMs > SKILLS_PULL_LOCK_STALE_MS;
  } catch {
    const stats = await fs.stat(lockPath).catch(() => null);
    stale = !stats || Date.now() - stats.mtimeMs > SKILLS_PULL_LOCK_STALE_MS;
  }
  if (!stale) return false;
  await fs.rm(lockPath, { force: true }).catch(() => {});
  return true;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : null;
    return code === "EPERM";
  }
}
