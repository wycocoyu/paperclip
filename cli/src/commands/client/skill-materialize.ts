import type {
  CompanySkillFileDetail,
  CompanySkillListItem,
  CompanySkillVersionFileInventoryEntry,
} from "@paperclipai/shared";
import {
  expandHome,
  isDirectory,
  isIgnoredSkillFile,
  materializeSkill,
  readSidecar,
  sidecarMatchesRemoteMarkers,
  type SkillSidecar,
} from "@paperclipai/skill-materializer";
import { join } from "node:path";
import type { ResolvedClientContext } from "./common.js";

export { expandHome, readSidecar, type SkillSidecar };

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

interface SkillTargetState {
  target: string;
  skillDir: string;
  sidecar: SkillSidecar | null;
  exists: boolean;
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

    const markers = {
      skillId: skill.id,
      key: skill.key,
      currentVersionId: skill.currentVersionId,
      updatedAt: skill.updatedAt,
    };
    if (states.every((state) => state.exists && sidecarMatchesRemoteMarkers(state.sidecar, markers))) {
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
    const files = [...remoteFiles].map(([path, content]) => ({ path, content }));
    for (const state of states) {
      const result = await materializeSkill({
        skillId: skill.id,
        targetDir: state.skillDir,
        files,
        sidecar: markers,
        force: opts.force,
        dryRun: opts.dryRun,
      });
      rows.push({
        skill: toSkillReferenceTarget(skill),
        target: state.target,
        status: result.status,
        files: result.files,
        note: result.note,
      });
    }
  }
  return rows;
}
