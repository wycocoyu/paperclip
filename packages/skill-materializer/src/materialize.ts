import { replaceSkillDirAtomically } from "./atomic.js";
import {
  SKILL_SIDECAR,
  hashFileMap,
  isDirectory,
  isIgnoredSkillFile,
  normalizePortablePath,
  readSkillDirFiles,
} from "./files.js";
import {
  buildSidecar,
  readSidecar,
  serializeSidecar,
  sidecarMarkersMatch,
  writeSidecar,
  type SkillSidecar,
} from "./sidecar.js";

export interface SkillSnapshotFile {
  path: string;
  content: string;
}

/** The server-side change markers a sidecar records alongside the content hash. */
export interface SkillSidecarBookkeeping {
  key: string;
  currentVersionId?: string | null;
  updatedAt?: Date | string | null;
}

export interface MaterializeSkillInput {
  skillId: string;
  /** Absolute path of the skill directory itself, not its parent. */
  targetDir: string;
  files: readonly SkillSnapshotFile[];
  /**
   * Present when the directory is one people may edit — the CLI's `skills-team`
   * checkout. It buys conflict detection and change-marker caching, and costs a
   * sidecar file. Absent for a directory the server owns outright, where the
   * snapshot content is the only thing that decides.
   */
  sidecar?: SkillSidecarBookkeeping;
  /** Refuse the whole write when the snapshot lacks this file. */
  requireFile?: string;
  force?: boolean;
  dryRun?: boolean;
  /** Injectable clock; the sidecar timestamps are otherwise untestable. */
  now?: () => Date;
}

export type MaterializeSkillStatus =
  | "created"
  | "updated"
  | "up-to-date"
  | "skipped-foreign"
  | "skipped-local-modified"
  | "dry-run";

export interface MaterializeSkillResult {
  status: MaterializeSkillStatus;
  /** Files the snapshot contributes, whether or not this run wrote them. */
  files: number;
  /** Tracked paths the snapshot no longer carries. */
  removed: string[];
  note?: string;
}

export class MissingRequiredSkillFileError extends Error {
  constructor(readonly requiredFile: string) {
    super(`Skill snapshot is missing ${requiredFile}.`);
    this.name = "MissingRequiredSkillFileError";
  }
}

export class EmptySkillSnapshotError extends Error {
  constructor() {
    super("Skill snapshot carries no files; refusing to materialize an empty skill directory.");
    this.name = "EmptySkillSnapshotError";
  }
}

// Snapshot paths arrive from an HTTP payload on one side and a database row on
// the other. Normalizing here is what lets both sides key off identical strings;
// the containment assert is the belt to that braces.
export function buildSnapshotFileMap(files: readonly SkillSnapshotFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    const relativePath = normalizePortablePath(file.path);
    if (!relativePath) continue;
    // A snapshot taken before the server stopped scanning it still carries the
    // sidecar; treating it as content would recreate the drift it caused.
    if (isIgnoredSkillFile(relativePath)) continue;
    if (relativePath.split("/").includes("..")) {
      throw new Error(`Skill version file path is invalid: ${file.path}`);
    }
    out.set(relativePath, file.content);
  }
  return out;
}

export async function materializeSkill(
  input: MaterializeSkillInput,
): Promise<MaterializeSkillResult> {
  const { targetDir, sidecar: bookkeeping, force = false, dryRun = false } = input;
  const now = input.now ?? (() => new Date());
  const snapshot = buildSnapshotFileMap(input.files);

  if (input.requireFile && !snapshot.has(normalizePortablePath(input.requireFile))) {
    throw new MissingRequiredSkillFileError(input.requireFile);
  }
  if (snapshot.size === 0) throw new EmptySkillSnapshotError();

  const snapshotHash = hashFileMap(snapshot);
  const exists = await isDirectory(targetDir);
  const current = bookkeeping && exists ? await readSidecar(targetDir) : null;

  if (!exists) {
    if (dryRun) return { status: "dry-run", files: snapshot.size, removed: [], note: "would create" };
    await write(input, snapshot, snapshotHash, [], false, now());
    return { status: "created", files: snapshot.size, removed: [] };
  }

  if (!bookkeeping) {
    const onDisk = await readSkillDirFiles(targetDir);
    if (hashFileMap(onDisk) === snapshotHash) {
      return { status: "up-to-date", files: snapshot.size, removed: [] };
    }
    if (dryRun) return { status: "dry-run", files: snapshot.size, removed: [], note: "would update" };
    await write(input, snapshot, snapshotHash, [], false, now());
    return { status: "updated", files: snapshot.size, removed: [] };
  }

  if (!current) {
    if (!force) {
      return {
        status: "skipped-foreign",
        files: 0,
        removed: [],
        note: "directory exists without a paperclip sidecar; use --force",
      };
    }
  } else {
    if (current.remoteHash === snapshotHash) {
      // The bytes are unchanged, so lastChangedAt must not move — but recording
      // the markers we just fetched is what stops the next pull refetching this
      // skill again.
      const refreshed = buildSidecar(
        { skillId: input.skillId, ...bookkeeping },
        snapshotHash,
        snapshot,
        current.lastChangedAt ?? current.syncedAt,
        now().toISOString(),
      );
      if (dryRun || sidecarMarkersMatch(current, refreshed)) {
        return { status: "up-to-date", files: snapshot.size, removed: [] };
      }
      await writeSidecar(targetDir, refreshed);
      return {
        status: "up-to-date",
        files: snapshot.size,
        removed: [],
        note: "change markers refreshed",
      };
    }
    const drift = await detectLocalDrift(targetDir, current, snapshot);
    if (drift && !force) {
      return {
        status: "skipped-local-modified",
        files: 0,
        removed: [],
        note: `${drift}; use --force to overwrite`,
      };
    }
  }

  if (dryRun) {
    return {
      status: "dry-run",
      files: snapshot.size,
      removed: [],
      note: current ? "would update" : "would force-create",
    };
  }
  const tracked = current?.files ?? [];
  const removed = tracked.filter((filePath) => !snapshot.has(filePath) && !isIgnoredSkillFile(filePath));
  await write(input, snapshot, snapshotHash, removed, true, now());
  return {
    status: "updated",
    files: snapshot.size,
    removed,
    note: removed.length > 0 ? `removed ${removed.length} file(s) deleted upstream` : undefined,
  };
}

async function write(
  input: MaterializeSkillInput,
  snapshot: Map<string, string>,
  snapshotHash: string,
  removed: readonly string[],
  seedFromExisting: boolean,
  now: Date,
): Promise<void> {
  const files = new Map(snapshot);
  if (input.sidecar) {
    const sidecar = buildSidecar(
      { skillId: input.skillId, ...input.sidecar },
      snapshotHash,
      snapshot,
      now.toISOString(),
      now.toISOString(),
    );
    files.set(SKILL_SIDECAR, serializeSidecar(sidecar));
  }
  await replaceSkillDirAtomically(input.targetDir, {
    write: files,
    remove: removed,
    seedFromExisting,
  });
}

async function detectLocalDrift(
  skillDir: string,
  sidecar: SkillSidecar,
  snapshot: ReadonlyMap<string, string>,
): Promise<string | null> {
  const onDisk = await readSkillDirFiles(skillDir);
  // Disk that already equals the remote is not a local edit, whatever the
  // sidecar hash claims — an older sidecar could have hashed files we no longer
  // read back, so the recorded hash can be wrong while the bytes are identical.
  if (hashFileMap(onDisk) === hashFileMap(snapshot)) return null;
  // Sidecars written before file tracking only ever knew the remote inventory,
  // so compare within that set rather than flagging pre-existing extras.
  const tracked = sidecar.files ?? [...snapshot.keys()];
  const trackedSet = new Set(tracked);
  if (sidecar.files) {
    const added = [...onDisk.keys()].filter((filePath) => !trackedSet.has(filePath));
    if (added.length > 0) {
      return `local files added since last sync (${added.slice(0, 3).join(", ")})`;
    }
  }
  const trackedOnDisk = new Map([...onDisk].filter(([filePath]) => trackedSet.has(filePath)));
  return hashFileMap(trackedOnDisk) === sidecar.localHash ? null : "local edits since last sync";
}
