import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";
import { hashSkillDir, isDirectory } from "@paperclipai/skill-materializer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TerminalSkillTool = "codex" | "claude" | "kimi" | "zcode" | "cursor" | "custom";

// Team skills materialize into the repo checkout beside the upstream `skills/`
// tree so both link sources live under one root and stay out of the worktree.
export const TEAM_SKILLS_DIRNAME = "skills-team";

export interface SkillLinkSource {
  dir: string;
  label: string;
  // Slugs this source is about to hold, unioned with whatever it holds now. A
  // dry-run before the first materialize has nothing to list yet, and a preview
  // that silently omits every team skill is worse than no preview.
  projectedNames?: string[];
}

export interface ResolvedSkillLink {
  name: string;
  source: string;
  label: string;
}

export interface ShadowedSkillLink {
  name: string;
  winner: string;
  loser: string;
}

export interface SkillsInstallSummary {
  tool: TerminalSkillTool;
  target: string;
  linked: string[];
  removed: string[];
  skipped: string[];
  adopted: string[];
  repointed: Array<{ name: string; from: string; to: string }>;
  shadowed: ShadowedSkillLink[];
  conflicts: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; error: string }>;
}

export interface InstallSkillsOptions {
  rebuild?: ReadonlySet<string>;
  adopt?: boolean;
  repoint?: boolean;
  dryRun?: boolean;
  // Unlinks every ~/.agents/skills link whose name is absent from this run's
  // sources. That predicate catches a user's own cross-terminal links, not just
  // ours, so only the rarely-run `agent local-cli` opts in — a hook-driven pull
  // would clear them on every session.
  sweepMaintainerOnly?: boolean;
}

export function codexSkillsHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".codex");
  return path.join(base, "skills");
}

export function claudeSkillsHome(): string {
  const fromEnv = process.env.CLAUDE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".claude");
  return path.join(base, "skills");
}

export function kimiSkillsHome(): string {
  const fromEnv = process.env.KIMI_CODE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".kimi-code");
  return path.join(base, "skills");
}

// ZCode discovers skills in ~/.agents/skills (the cross-tool shared dir) in
// addition to its own ~/.zcode/skills — installing into the shared dir keeps
// one link serving ZCode today and any other tool that adopts the convention.
export function zcodeSkillsHome(): string {
  const fromEnv = process.env.ZCODE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".agents");
  return path.join(base, "skills");
}

// `CURSOR_HOME` names the `.cursor` directory itself, the same way the repo's
// cursor-local adapter reads it, so the skills home hangs off it unchanged.
//
// Cursor also carries a second, server-driven set of links here, named
// `<slug>--<hash>` and pointing at the agent's managed source
// (`server/src/services/company-skills.ts` buildSkillRuntimeName). Those are
// not this function's business: `skills pull` only ever touches slugs its own
// sources claim, so the two sets coexist in one directory.
export function cursorSkillsHome(): string {
  const fromEnv = process.env.CURSOR_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".cursor");
  return path.join(base, "skills");
}

export function terminalSkillTargets(): Array<{ tool: TerminalSkillTool; dir: string }> {
  return [
    { tool: "codex", dir: codexSkillsHome() },
    { tool: "claude", dir: claudeSkillsHome() },
    { tool: "kimi", dir: kimiSkillsHome() },
    { tool: "zcode", dir: zcodeSkillsHome() },
    { tool: "cursor", dir: cursorSkillsHome() },
  ];
}

// The repo checkout is the canonical home for both link sources. Resolution
// starts from the CLI module because `skills pull` is also fired by editor hooks
// from whatever directory the user happens to sit in.
export async function resolvePaperclipRepoRoot(startDirs: string[]): Promise<string | null> {
  for (const start of startDirs) {
    let dir = path.resolve(start);
    while (true) {
      const marked = await fs
        .stat(path.join(dir, "pnpm-workspace.yaml"))
        .then((stats) => stats.isFile())
        .catch(() => false);
      if (marked && (await isDirectory(path.join(dir, "skills")))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export async function resolveSkillLinkSources(
  sources: SkillLinkSource[],
): Promise<{ links: ResolvedSkillLink[]; shadowed: ShadowedSkillLink[] }> {
  const links = new Map<string, ResolvedSkillLink>();
  const shadowed: ShadowedSkillLink[] = [];
  for (const source of sources) {
    // A source that has not been materialized yet contributes no slugs rather
    // than failing the whole run.
    const entries = await fs.readdir(source.dir, { withFileTypes: true }).catch(() => []);
    const names = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    for (const projected of source.projectedNames ?? []) names.add(projected);

    for (const name of [...names].sort()) {
      const claimed = links.get(name);
      if (claimed) {
        shadowed.push({
          name,
          winner: claimed.source,
          loser: path.join(source.dir, name),
        });
        continue;
      }
      links.set(name, {
        name,
        source: path.join(source.dir, name),
        label: source.label,
      });
    }
  }
  return { links: [...links.values()], shadowed };
}

export interface SkillLinkInspection {
  state: "absent" | "correct" | "dangling" | "elsewhere" | "occupied";
  linkedTo?: string;
}

// The authoritative source for a slug is whichever configured source claims it
// first, so correctness is "points at that exact path" — never "points anywhere
// under a source root".
export async function inspectSkillLink(target: string, source: string): Promise<SkillLinkInspection> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) return { state: "absent" };
  if (!existing.isSymbolicLink()) return { state: "occupied" };

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return { state: "dangling" };
  const resolved = path.resolve(
    path.isAbsolute(linkedPath) ? linkedPath : path.resolve(path.dirname(target), linkedPath),
  );
  const linkedTargetExists = await fs
    .stat(resolved)
    .then(() => true)
    .catch(() => false);
  if (!linkedTargetExists) return { state: "dangling", linkedTo: resolved };
  if (resolved === path.resolve(source)) return { state: "correct", linkedTo: resolved };
  return { state: "elsewhere", linkedTo: resolved };
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Replaces the link in one rename so a concurrent session never observes the
// slug missing; unlink-then-symlink leaves a window that other terminals scan.
async function relinkAtomically(source: string, target: string): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}`);
  await fs.rm(temp, { recursive: true, force: true });
  await fs.symlink(source, temp);
  try {
    await fs.rename(temp, target);
  } catch (err) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function installSkillsForTarget(
  sources: SkillLinkSource[],
  targetSkillsDir: string,
  tool: TerminalSkillTool,
  opts: InstallSkillsOptions = {},
): Promise<SkillsInstallSummary> {
  const summary: SkillsInstallSummary = {
    tool,
    target: targetSkillsDir,
    linked: [],
    removed: [],
    skipped: [],
    adopted: [],
    repointed: [],
    shadowed: [],
    conflicts: [],
    failed: [],
  };

  if (!opts.dryRun) await fs.mkdir(targetSkillsDir, { recursive: true });
  const { links, shadowed } = await resolveSkillLinkSources(sources);
  summary.shadowed = shadowed;

  if (!opts.dryRun && opts.sweepMaintainerOnly) {
    summary.removed = await removeMaintainerOnlySkillSymlinks(
      targetSkillsDir,
      links.map((link) => link.name),
    );
  }

  for (const link of links) {
    const target = path.join(targetSkillsDir, link.name);
    const inspection = await inspectSkillLink(target, link.source);

    if (inspection.state === "correct" && !opts.rebuild?.has(link.name)) {
      summary.skipped.push(link.name);
      continue;
    }

    let repointedFrom: string | null = null;
    if (inspection.state === "elsewhere") {
      if (!opts.repoint) {
        summary.skipped.push(link.name);
        summary.conflicts.push({
          name: link.name,
          reason: `existing symlink points at ${inspection.linkedTo}; left untouched`,
        });
        continue;
      }
      repointedFrom = inspection.linkedTo ?? "";
    }

    let adopted = false;
    if (inspection.state === "occupied") {
      if (!(await tryAdoptSkillDirectory(target, link.source, summary, opts))) continue;
      adopted = true;
    }

    const record = () => {
      summary.linked.push(link.name);
      if (adopted) summary.adopted.push(link.name);
      if (repointedFrom !== null) {
        summary.repointed.push({ name: link.name, from: repointedFrom, to: link.source });
      }
    };

    if (opts.dryRun) {
      record();
      continue;
    }
    try {
      await relinkAtomically(link.source, target);
      record();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      summary.failed.push({
        name: link.name,
        // An adopted directory is already gone by this point, so say so rather
        // than leaving the slug looking merely unlinked.
        error: adopted ? `${reason} (the adopted directory was already removed)` : reason,
      });
    }
  }

  return summary;
}

// Replacing a real directory is the one destructive step here, so it needs
// --adopt plus byte-identical content. On a case-insensitive filesystem the
// lowercase slug path resolves onto a differently-cased directory, which is
// exactly the migration this handles.
async function tryAdoptSkillDirectory(
  target: string,
  source: string,
  summary: SkillsInstallSummary,
  opts: InstallSkillsOptions,
): Promise<boolean> {
  const name = path.basename(target);
  if (!opts.adopt) {
    summary.skipped.push(name);
    summary.conflicts.push({
      name,
      reason: "a real directory already occupies this slug; rerun with --adopt to migrate it",
    });
    return false;
  }
  if (!(await isDirectory(target))) {
    summary.skipped.push(name);
    summary.conflicts.push({ name, reason: "slug is occupied by a file, not a skill directory" });
    return false;
  }
  // Without bytes on both sides there is nothing to compare, and guessing here
  // would promise a deletion this run cannot actually justify.
  if (!(await isDirectory(source))) {
    summary.skipped.push(name);
    summary.conflicts.push({
      name,
      reason: "cannot preview adoption before the first materialize; rerun after a real pull",
    });
    return false;
  }
  const [targetHash, sourceHash] = await Promise.all([hashSkillDir(target), hashSkillDir(source)]);
  if (targetHash !== sourceHash) {
    summary.skipped.push(name);
    summary.conflicts.push({
      name,
      reason: "local copy differs from the company skill; resolve it by hand before adopting",
    });
    return false;
  }
  if (opts.dryRun) return true;
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch (err) {
    summary.failed.push({ name, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
  return true;
}

export interface TerminalPruneRow {
  target: string;
  name: string;
  linkedTo: string;
  action: "removed" | "would-remove";
}

// Terminal skill directories hold far more than the company library, so pruning
// only ever touches links we planted that now dangle. Anything else — real
// directories, foreign links, live links — is left exactly as found.
export async function pruneTerminalSkillLinks(
  targetSkillsDir: string,
  managedRoot: string,
  opts: { apply: boolean },
): Promise<TerminalPruneRow[]> {
  const entries = await fs.readdir(targetSkillsDir, { withFileTypes: true }).catch(() => []);
  const rows: TerminalPruneRow[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const target = path.join(targetSkillsDir, entry.name);
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;
    const resolved = path.resolve(
      path.isAbsolute(linkedPath) ? linkedPath : path.resolve(path.dirname(target), linkedPath),
    );
    if (!isInside(resolved, path.resolve(managedRoot))) continue;
    const linkedTargetExists = await fs
      .stat(resolved)
      .then(() => true)
      .catch(() => false);
    if (linkedTargetExists) continue;

    if (opts.apply) await fs.unlink(target).catch(() => {});
    rows.push({
      target: targetSkillsDir,
      name: entry.name,
      linkedTo: resolved,
      action: opts.apply ? "removed" : "would-remove",
    });
  }
  return rows;
}

export async function containsPullManagedLinks(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkedPath = await fs.readlink(path.join(dir, entry.name)).catch(() => null);
    if (!linkedPath) continue;
    const resolved = path.resolve(
      path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(dir, linkedPath),
    );
    if (resolved.split(path.sep).includes(TEAM_SKILLS_DIRNAME)) return true;
  }
  return false;
}

// `.git/info/exclude` rather than a tracked .gitignore: team skills must leave
// zero diff against upstream. In a worktree the exclude file lives in the shared
// common dir, which is what git itself reads.
export async function ensureGitExcludeEntry(
  repoRoot: string,
  entry: string,
): Promise<"added" | "present" | "unavailable"> {
  const excludePath = await resolveGitInfoExcludePath(repoRoot);
  if (!excludePath) return "unavailable";
  const existing = await fs.readFile(excludePath, "utf8").catch(() => null);
  if (existing !== null && existing.split("\n").some((line) => line.trim() === entry)) {
    return "present";
  }
  const prefix = existing === null || existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.appendFile(excludePath, `${prefix}${entry}\n`, "utf8");
  return "added";
}

async function resolveGitInfoExcludePath(repoRoot: string): Promise<string | null> {
  const dotGit = path.join(repoRoot, ".git");
  const stats = await fs.stat(dotGit).catch(() => null);
  if (!stats) return null;
  if (stats.isDirectory()) return path.join(dotGit, "info", "exclude");

  const pointer = await fs.readFile(dotGit, "utf8").catch(() => "");
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match?.[1]) return null;
  const gitDir = path.resolve(repoRoot, match[1].trim());
  const worktreesMarker = `${path.sep}worktrees${path.sep}`;
  const markerIdx = gitDir.lastIndexOf(worktreesMarker);
  const commonDir = markerIdx === -1 ? gitDir : gitDir.slice(0, markerIdx);
  return path.join(commonDir, "info", "exclude");
}
