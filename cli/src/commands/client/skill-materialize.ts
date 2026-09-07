import type {
  CompanySkillFileDetail,
  CompanySkillListItem,
  CompanySkillVersionFileInventoryEntry,
} from "@paperclipai/shared";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  SKILL_SIDECAR,
  hashFileMap,
  isDirectory,
  isIgnoredSkillFile,
  parentDirOf,
  readSkillDirFiles,
} from "./skill-files.js";
import type { ResolvedClientContext } from "./common.js";

export interface SkillMaterializeOptions {
  target: string[];
  skill: string[];
  dryRun: boolean;
  force: boolean;
}

export type CompanySkillReferenceTarget = Pick<CompanySkillListItem, "id" | "key" | "slug" | "name">;

export interface SkillMaterializeRow {
  skill: CompanySkillReferenceTarget;
  target: string;
  status:
    | "created"
    | "updated"
    | "up-to-date"
    | "skipped-foreign"
    | "skipped-local-modified"
    | "skipped-no-files"
    | "dry-run";
  files: number;
  note?: string;
}

export interface SkillSidecar {
  skillId: string;
  key: string;
  remoteHash: string;
  localHash: string;
  syncedAt: string;
  // Server change markers the bytes came from — one list call compares them
  // against every skill and turns the steady state into zero per-skill fetches.
  // currentVersionId is null for a sizeable slice of a real library, so
  // updatedAt has to carry the signal on its own for those.
  currentVersionId?: string | null;
  updatedAt?: string | null;
  // Full path list of what we wrote, so upstream deletions propagate and local
  // additions register as drift.
  files?: string[];
  // When the content itself last changed. Consumers throttle on it, so a pull
  // that finds nothing new must leave it alone.
  lastChangedAt?: string;
}

interface SkillTargetState {
  target: string;
  skillDir: string;
  sidecar: SkillSidecar | null;
  exists: boolean;
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolvePath(value);
}

export async function listCompanySkills(ctx: ResolvedClientContext): Promise<CompanySkillListItem[]> {
  return (await ctx.api.get<CompanySkillListItem[]>(`/api/companies/${ctx.companyId}/skills`)) ?? [];
}

export function resolveCompanySkillReference<T extends CompanySkillReferenceTarget>(
  skills: T[],
  reference: string,
): T {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error("Skill reference is required.");
  }

  const byId = skills.find((skill) => skill.id === trimmed);
  if (byId) return byId;

  const byKey = skills.find((skill) => skill.key === trimmed);
  if (byKey) return byKey;

  const normalizedSlug = normalizeSkillSlug(trimmed);
  const bySlug = skills.filter((skill) => skill.slug === normalizedSlug);
  if (bySlug.length === 1 && bySlug[0]) return bySlug[0];
  if (bySlug.length > 1) {
    throw new Error(`Ambiguous skill slug "${trimmed}". Use a skill ID or key instead.`);
  }

  throw new Error(`Skill not found: ${reference}`);
}

export function normalizeSkillSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function toSkillReferenceTarget(skill: CompanySkillReferenceTarget): CompanySkillReferenceTarget {
  return {
    id: skill.id,
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
  };
}

interface SkillVersionSummary {
  id: string;
  revisionNumber: number | null;
  fileInventory?: CompanySkillVersionFileInventoryEntry[];
}

async function fetchSkillFiles(
  ctx: ResolvedClientContext,
  skillId: string,
): Promise<Map<string, string>> {
  // The latest version's fileInventory carries each file's content; fall back
  // to per-file reads only for entries that somehow ship without one.
  const versions = await ctx.api.get<SkillVersionSummary[]>(
    `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}/versions`,
  );
  const latest = [...(versions ?? [])].sort(
    (a, b) => (b.revisionNumber ?? 0) - (a.revisionNumber ?? 0),
  )[0];
  const files = new Map<string, string>();
  for (const entry of latest?.fileInventory ?? []) {
    // Snapshots taken before the server stopped scanning it still carry the
    // sidecar; treating it as content would recreate the drift it caused.
    if (isIgnoredSkillFile(entry.path)) continue;
    if (typeof entry.content === "string") {
      files.set(entry.path, entry.content);
      continue;
    }
    const detail = await ctx.api.get<CompanySkillFileDetail>(
      `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}/files?path=${encodeURIComponent(entry.path)}`,
    );
    if (detail?.content !== undefined) files.set(detail.path, detail.content);
  }
  return files;
}

export async function readSidecar(skillDir: string): Promise<SkillSidecar | null> {
  try {
    const raw = await readFile(join(skillDir, SKILL_SIDECAR), "utf8");
    const parsed = JSON.parse(raw) as SkillSidecar;
    if (parsed && typeof parsed.skillId === "string" && typeof parsed.remoteHash === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

async function writeSidecar(skillDir: string, sidecar: SkillSidecar): Promise<void> {
  await writeFile(join(skillDir, SKILL_SIDECAR), JSON.stringify(sidecar, null, 2) + "\n", "utf8");
}

function normalizeTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildSidecar(
  skill: CompanySkillListItem,
  remoteHash: string,
  remoteFiles: Map<string, string>,
  lastChangedAt: string,
): SkillSidecar {
  return {
    skillId: skill.id,
    key: skill.key,
    remoteHash,
    localHash: remoteHash,
    syncedAt: new Date().toISOString(),
    currentVersionId: skill.currentVersionId ?? null,
    updatedAt: normalizeTimestamp(skill.updatedAt),
    files: [...remoteFiles.keys()].sort(),
    lastChangedAt,
  };
}

function sidecarCarriesFullState(sidecar: SkillSidecar): boolean {
  return (
    sidecar.currentVersionId !== undefined &&
    sidecar.updatedAt !== undefined &&
    Array.isArray(sidecar.files) &&
    typeof sidecar.lastChangedAt === "string"
  );
}

function sidecarMarkersMatch(current: SkillSidecar, next: SkillSidecar): boolean {
  return (
    sidecarCarriesFullState(current) &&
    current.currentVersionId === next.currentVersionId &&
    current.updatedAt === next.updatedAt &&
    current.lastChangedAt === next.lastChangedAt &&
    (current.files ?? []).join("\0") === (next.files ?? []).join("\0")
  );
}

// Either marker drifting means "might have changed", which costs one extra
// fetch-and-compare. Trusting only currentVersionId would silently skip every
// skill the server leaves unversioned.
function versionMatches(state: SkillTargetState, skill: CompanySkillListItem): boolean {
  const sidecar = state.sidecar;
  if (!state.exists || !sidecar || !sidecarCarriesFullState(sidecar)) return false;
  if (sidecar.skillId !== skill.id) return false;
  const remoteUpdatedAt = normalizeTimestamp(skill.updatedAt);
  if (!remoteUpdatedAt || sidecar.updatedAt !== remoteUpdatedAt) return false;
  return (sidecar.currentVersionId ?? null) === (skill.currentVersionId ?? null);
}

async function writeSkillFiles(
  skillDir: string,
  remoteFiles: Map<string, string>,
  trackedPaths: string[],
): Promise<string[]> {
  for (const [filePath, content] of remoteFiles) {
    await mkdir(join(skillDir, parentDirOf(filePath)), { recursive: true });
    await writeFile(join(skillDir, filePath), content, "utf8");
  }
  const removed: string[] = [];
  for (const filePath of trackedPaths) {
    if (remoteFiles.has(filePath) || isIgnoredSkillFile(filePath)) continue;
    await rm(join(skillDir, filePath), { force: true });
    removed.push(filePath);
    await removeEmptyAncestors(skillDir, parentDirOf(filePath));
  }
  return removed;
}

async function removeEmptyAncestors(skillDir: string, relativeDir: string): Promise<void> {
  let current = relativeDir;
  while (current) {
    const absolute = join(skillDir, current);
    const entries = await readdir(absolute).catch(() => null);
    if (entries === null || entries.length > 0) return;
    await rm(absolute, { recursive: true, force: true });
    current = parentDirOf(current);
  }
}

async function detectLocalDrift(
  skillDir: string,
  sidecar: SkillSidecar,
  remoteFiles: Map<string, string>,
): Promise<string | null> {
  const onDisk = await readSkillDirFiles(skillDir);
  // Disk that already equals the remote is not a local edit, whatever the
  // sidecar hash claims — an older sidecar could have hashed files we no longer
  // read back, so the recorded hash can be wrong while the bytes are identical.
  if (hashFileMap(onDisk) === hashFileMap(remoteFiles)) return null;
  // Sidecars written before file tracking only ever knew the remote inventory,
  // so compare within that set rather than flagging pre-existing extras.
  const tracked = sidecar.files ?? [...remoteFiles.keys()];
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

export async function materializeCompanySkills(
  ctx: ResolvedClientContext,
  opts: SkillMaterializeOptions,
): Promise<SkillMaterializeRow[]> {
  const all = await listCompanySkills(ctx);
  const selected = opts.skill.length > 0
    ? opts.skill.map((ref) => resolveCompanySkillReference(all, ref))
    : all;
  const targets = opts.target.map(expandHome);

  const rows: SkillMaterializeRow[] = [];
  for (const skill of selected) {
    const states = await Promise.all(targets.map(async (target): Promise<SkillTargetState> => {
      const skillDir = join(target, skill.slug);
      return {
        target,
        skillDir,
        sidecar: await readSidecar(skillDir),
        exists: await isDirectory(skillDir),
      };
    }));

    if (states.every((state) => versionMatches(state, skill))) {
      for (const state of states) {
        rows.push({
          skill: toSkillReferenceTarget(skill),
          target: state.target,
          status: "up-to-date",
          files: state.sidecar?.files?.length ?? 0,
        });
      }
      continue;
    }

    const remoteFiles = await fetchSkillFiles(ctx, skill.id);
    if (remoteFiles.size === 0) {
      for (const state of states) {
        rows.push({
          skill: toSkillReferenceTarget(skill),
          target: state.target,
          status: "skipped-no-files",
          files: 0,
          note: "skill has no retrievable files (plugin-managed or empty); nothing to materialize",
        });
      }
      continue;
    }
    const remoteHash = hashFileMap(remoteFiles);
    for (const state of states) {
      rows.push(await materializeOneTarget(skill, remoteFiles, remoteHash, state, opts));
    }
  }
  return rows;
}

async function materializeOneTarget(
  skill: CompanySkillListItem,
  remoteFiles: Map<string, string>,
  remoteHash: string,
  state: SkillTargetState,
  opts: SkillMaterializeOptions,
): Promise<SkillMaterializeRow> {
  const { target, skillDir, sidecar } = state;
  const ref = toSkillReferenceTarget(skill);

  if (!state.exists) {
    if (opts.dryRun) {
      return { skill: ref, target, status: "dry-run", files: remoteFiles.size, note: "would create" };
    }
    await mkdir(skillDir, { recursive: true });
    await writeSkillFiles(skillDir, remoteFiles, []);
    await writeSidecar(skillDir, buildSidecar(skill, remoteHash, remoteFiles, new Date().toISOString()));
    return { skill: ref, target, status: "created", files: remoteFiles.size };
  }

  if (!sidecar) {
    if (!opts.force) {
      return {
        skill: ref,
        target,
        status: "skipped-foreign",
        files: 0,
        note: "directory exists without a paperclip sidecar; use --force",
      };
    }
  } else {
    if (sidecar.remoteHash === remoteHash) {
      // The bytes are unchanged, so lastChangedAt must not move — but recording
      // the markers we just fetched is what stops the next pull refetching this
      // skill again.
      const refreshed = buildSidecar(skill, remoteHash, remoteFiles, sidecar.lastChangedAt ?? sidecar.syncedAt);
      if (opts.dryRun || sidecarMarkersMatch(sidecar, refreshed)) {
        return { skill: ref, target, status: "up-to-date", files: remoteFiles.size };
      }
      await writeSidecar(skillDir, refreshed);
      return {
        skill: ref,
        target,
        status: "up-to-date",
        files: remoteFiles.size,
        note: "change markers refreshed",
      };
    }
    const drift = await detectLocalDrift(skillDir, sidecar, remoteFiles);
    if (drift && !opts.force) {
      return {
        skill: ref,
        target,
        status: "skipped-local-modified",
        files: 0,
        note: `${drift}; use --force to overwrite`,
      };
    }
  }

  if (opts.dryRun) {
    return {
      skill: ref,
      target,
      status: "dry-run",
      files: remoteFiles.size,
      note: sidecar ? "would update" : "would force-create",
    };
  }
  const removed = await writeSkillFiles(skillDir, remoteFiles, sidecar?.files ?? []);
  await writeSidecar(skillDir, buildSidecar(skill, remoteHash, remoteFiles, new Date().toISOString()));
  return {
    skill: ref,
    target,
    status: "updated",
    files: remoteFiles.size,
    note: removed.length > 0 ? `removed ${removed.length} file(s) deleted upstream` : undefined,
  };
}
