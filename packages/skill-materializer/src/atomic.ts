import fs from "node:fs/promises";
import path from "node:path";
import { parentDirOf } from "./files.js";

export interface SkillDirWritePlan {
  /** Relative POSIX path -> content. Written last, so it wins over seeded bytes. */
  write: ReadonlyMap<string, string>;
  /** Relative POSIX paths to drop from the seeded copy. */
  remove: readonly string[];
  /**
   * Copy the current directory into the staging area before applying the plan.
   * On for a directory people may add files to; off for a directory we own
   * outright, where anything not in the snapshot is stale by definition.
   */
  seedFromExisting: boolean;
}

let stagingSequence = 0;

// Builds the whole directory off to the side and swaps it in, so a concurrent
// reader sees the old set or the new one — never a file-by-file mixture. The
// swap is two renames, which leaves a sub-millisecond window where the path is
// absent; POSIX has no rename that atomically replaces a non-empty directory.
export async function replaceSkillDirAtomically(
  targetDir: string,
  plan: SkillDirWritePlan,
): Promise<void> {
  const parent = path.dirname(targetDir);
  stagingSequence += 1;
  const stage = path.join(parent, `.${path.basename(targetDir)}.paperclip-tmp-${process.pid}-${stagingSequence}`);
  const backup = `${stage}.old`;

  await fs.mkdir(parent, { recursive: true });
  await fs.rm(stage, { recursive: true, force: true });
  try {
    await seedStagingDir(targetDir, stage, plan.seedFromExisting);
    for (const relativePath of plan.remove) {
      await fs.rm(path.join(stage, relativePath), { recursive: true, force: true });
      await removeEmptyAncestors(stage, parentDirOf(relativePath));
    }
    for (const [relativePath, content] of plan.write) {
      const absolute = path.join(stage, relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf8");
    }
    await swapIn(stage, targetDir, backup);
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

async function seedStagingDir(targetDir: string, stage: string, seed: boolean): Promise<void> {
  if (seed) {
    const copied = await fs
      .cp(targetDir, stage, { recursive: true, force: true, verbatimSymlinks: true })
      .then(() => true)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return false;
        throw err;
      });
    if (copied) return;
  }
  await fs.mkdir(stage, { recursive: true });
}

async function swapIn(stage: string, targetDir: string, backup: string): Promise<void> {
  await fs.rm(backup, { recursive: true, force: true });
  const displaced = await fs
    .rename(targetDir, backup)
    .then(() => true)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false;
      throw err;
    });
  try {
    await fs.rename(stage, targetDir);
  } catch (err) {
    if (displaced) await fs.rename(backup, targetDir).catch(() => {});
    throw err;
  }
}

async function removeEmptyAncestors(root: string, relativeDir: string): Promise<void> {
  let current = relativeDir;
  while (current) {
    const absolute = path.join(root, current);
    const entries = await fs.readdir(absolute).catch(() => null);
    if (entries === null || entries.length > 0) return;
    await fs.rm(absolute, { recursive: true, force: true });
    current = parentDirOf(current);
  }
}
