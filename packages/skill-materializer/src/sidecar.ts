import fs from "node:fs/promises";
import path from "node:path";
import { SKILL_SIDECAR } from "./files.js";

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

// Identity plus the server-side change markers a sidecar records. The snapshot
// content itself is passed separately, so this stays the whole "which skill,
// which server state" half of the bookkeeping.
export interface SkillSidecarIdentity {
  skillId: string;
  key: string;
  currentVersionId?: string | null;
  updatedAt?: Date | string | null;
}

export function normalizeSidecarTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function readSidecar(skillDir: string): Promise<SkillSidecar | null> {
  try {
    const raw = await fs.readFile(path.join(skillDir, SKILL_SIDECAR), "utf8");
    const parsed = JSON.parse(raw) as SkillSidecar;
    if (parsed && typeof parsed.skillId === "string" && typeof parsed.remoteHash === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function serializeSidecar(sidecar: SkillSidecar): string {
  return JSON.stringify(sidecar, null, 2) + "\n";
}

// A lone marker refresh rewrites one file in a directory other terminals read,
// so it lands through a rename rather than a truncate-and-write.
export async function writeSidecar(skillDir: string, sidecar: SkillSidecar): Promise<void> {
  const target = path.join(skillDir, SKILL_SIDECAR);
  const temp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temp, serializeSidecar(sidecar), "utf8");
  try {
    await fs.rename(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

export function buildSidecar(
  identity: SkillSidecarIdentity,
  remoteHash: string,
  remoteFiles: ReadonlyMap<string, string>,
  lastChangedAt: string,
  syncedAt: string,
): SkillSidecar {
  return {
    skillId: identity.skillId,
    key: identity.key,
    remoteHash,
    localHash: remoteHash,
    syncedAt,
    currentVersionId: identity.currentVersionId ?? null,
    updatedAt: normalizeSidecarTimestamp(identity.updatedAt),
    files: [...remoteFiles.keys()].sort(),
    lastChangedAt,
  };
}

export function sidecarCarriesFullState(sidecar: SkillSidecar): boolean {
  return (
    sidecar.currentVersionId !== undefined &&
    sidecar.updatedAt !== undefined &&
    Array.isArray(sidecar.files) &&
    typeof sidecar.lastChangedAt === "string"
  );
}

export function sidecarMarkersMatch(current: SkillSidecar, next: SkillSidecar): boolean {
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
export function sidecarMatchesRemoteMarkers(
  sidecar: SkillSidecar | null,
  identity: SkillSidecarIdentity,
): boolean {
  if (!sidecar || !sidecarCarriesFullState(sidecar)) return false;
  if (sidecar.skillId !== identity.skillId) return false;
  const remoteUpdatedAt = normalizeSidecarTimestamp(identity.updatedAt);
  if (!remoteUpdatedAt || sidecar.updatedAt !== remoteUpdatedAt) return false;
  return (sidecar.currentVersionId ?? null) === (identity.currentVersionId ?? null);
}
