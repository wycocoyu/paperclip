import {
  acquireSkillsPullLock,
  hashFileMap,
  readSkillDirFiles,
  skillsPullLockPath,
  type SkillsPullLock,
} from "@paperclipai/skill-materializer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedClientContext } from "./common.js";
import {
  TEAM_SKILLS_DIRNAME,
  ensureGitExcludeEntry,
  installSkillsForTarget,
  pruneTerminalSkillLinks,
  resolvePaperclipRepoRoot,
  terminalSkillTargets,
  type SkillsInstallSummary,
  type TerminalPruneRow,
  type TerminalSkillTool,
} from "./skill-links.js";
import {
  expandHome,
  materializeCompanySkills,
  readSidecar,
  type SkillMaterializeRow,
} from "./skill-materialize.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const SKILLS_PULL_HINT =
  "Run `paperclipai skills pull` to link this change into your local terminal skill directories.";

export interface SkillsPullOptions {
  dir: string[];
  adopt: boolean;
  pruneApply: boolean;
  dryRun: boolean;
  force: boolean;
}

export interface RepoPruneRow {
  name: string;
  action: "removed" | "would-remove" | "kept";
  reason?: string;
}

export interface SkillsPullResult {
  repoRoot: string;
  upstreamDir: string;
  teamDir: string;
  gitExclude: "added" | "present" | "unavailable" | "skipped";
  materialize: SkillMaterializeRow[];
  changed: string[];
  links: SkillsInstallSummary[];
  repoPrune: RepoPruneRow[];
  terminalPrune: TerminalPruneRow[];
}

// Every status but skipped-no-files ends with a directory under skills-team —
// including the skipped ones, which are skipped precisely because a directory is
// already sitting there.
export function projectedTeamSkillNames(rows: SkillMaterializeRow[]): string[] {
  return [
    ...new Set(
      rows.filter((row) => row.status !== "skipped-no-files").map((row) => row.skill.slug),
    ),
  ];
}

// The lock lives in the shared materializer: the server writes these same
// directories, so both processes have to contend for one path.
export { acquireSkillsPullLock, skillsPullLockPath, type SkillsPullLock };

export async function resolveSkillsPullRoot(): Promise<string> {
  const repoRoot = await resolvePaperclipRepoRoot([__moduleDir, process.cwd()]);
  if (!repoRoot) {
    throw new Error(
      "Could not locate the Paperclip repo checkout (expected a directory holding both pnpm-workspace.yaml and skills/). `skills pull` materializes team skills into the checkout, so run it from an installed CLI or from inside the repo.",
    );
  }
  return repoRoot;
}

function resolvePullTargets(dirs: string[]): Array<{ tool: TerminalSkillTool; dir: string }> {
  if (dirs.length === 0) return terminalSkillTargets();
  const known = terminalSkillTargets();
  return dirs.map((raw) => {
    const dir = expandHome(raw);
    const match = known.find((entry) => path.resolve(entry.dir) === path.resolve(dir));
    return { tool: match?.tool ?? "custom", dir };
  });
}

export async function runSkillsPull(
  ctx: ResolvedClientContext,
  opts: SkillsPullOptions,
): Promise<SkillsPullResult | null> {
  const repoRoot = await resolveSkillsPullRoot();
  const upstreamDir = path.join(repoRoot, "skills");
  const teamDir = path.join(repoRoot, TEAM_SKILLS_DIRNAME);

  const lock = await acquireSkillsPullLock(skillsPullLockPath());
  if (!lock) return null;

  try {
    const gitExclude = opts.dryRun
      ? ("skipped" as const)
      : await ensureGitExcludeEntry(repoRoot, `${TEAM_SKILLS_DIRNAME}/`);
    if (!opts.dryRun) await fs.mkdir(teamDir, { recursive: true });

    const materialize = await materializeCompanySkills(ctx, {
      target: [teamDir],
      skill: [],
      dryRun: opts.dryRun,
      force: opts.force,
    });
    const changed = new Set(
      materialize
        .filter((row) => row.status === "created" || row.status === "updated")
        .map((row) => row.skill.slug),
    );

    const sources = [
      { dir: upstreamDir, label: "skills" },
      {
        dir: teamDir,
        label: TEAM_SKILLS_DIRNAME,
        // A real run has already written these directories by now; a dry run has
        // not, so the plan has to come from the materialize rows instead.
        projectedNames: opts.dryRun ? projectedTeamSkillNames(materialize) : undefined,
      },
    ];
    const targets = resolvePullTargets(opts.dir);
    const links: SkillsInstallSummary[] = [];
    for (const target of targets) {
      links.push(
        await installSkillsForTarget(sources, target.dir, target.tool, {
          rebuild: changed,
          adopt: opts.adopt,
          repoint: true,
          dryRun: opts.dryRun,
        }),
      );
    }

    const apply = opts.pruneApply && !opts.dryRun;
    const repoPrune = await pruneTeamSkillDirs(
      teamDir,
      new Set(materialize.map((row) => row.skill.slug)),
      { apply },
    );
    const terminalPrune: TerminalPruneRow[] = [];
    for (const target of targets) {
      terminalPrune.push(...(await pruneTerminalSkillLinks(target.dir, teamDir, { apply })));
    }

    return {
      repoRoot,
      upstreamDir,
      teamDir,
      gitExclude,
      materialize,
      changed: [...changed],
      links,
      repoPrune,
      terminalPrune,
    };
  } finally {
    await lock.release();
  }
}

// Repo-side pruning is safe to be thorough about: everything under skills-team
// was written by us. A directory only goes when its sidecar proves nothing local
// would be lost.
export async function pruneTeamSkillDirs(
  teamDir: string,
  keepSlugs: ReadonlySet<string>,
  opts: { apply: boolean },
): Promise<RepoPruneRow[]> {
  const entries = await fs.readdir(teamDir, { withFileTypes: true }).catch(() => []);
  const rows: RepoPruneRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || keepSlugs.has(entry.name)) continue;
    const skillDir = path.join(teamDir, entry.name);
    const sidecar = await readSidecar(skillDir);
    if (!sidecar) {
      rows.push({ name: entry.name, action: "kept", reason: "no paperclip sidecar; remove it by hand" });
      continue;
    }
    const onDisk = await readSkillDirFiles(skillDir);
    const tracked = new Set(sidecar.files ?? [...onDisk.keys()]);
    const trackedOnDisk = new Map([...onDisk].filter(([filePath]) => tracked.has(filePath)));
    const extra = [...onDisk.keys()].filter((filePath) => !tracked.has(filePath));
    if (extra.length > 0 || hashFileMap(trackedOnDisk) !== sidecar.localHash) {
      rows.push({ name: entry.name, action: "kept", reason: "local edits since last sync" });
      continue;
    }
    if (opts.apply) await fs.rm(skillDir, { recursive: true, force: true });
    rows.push({ name: entry.name, action: opts.apply ? "removed" : "would-remove" });
  }
  return rows;
}

export function printSkillsPullResult(result: SkillsPullResult, opts: SkillsPullOptions): void {
  console.log(`repo=${result.repoRoot} team=${result.teamDir} gitExclude=${result.gitExclude}`);
  const counts = new Map<string, number>();
  for (const row of result.materialize) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  console.log(
    `skills: ${[...counts].map(([status, count]) => `${status}=${count}`).join(" ") || "none"}`,
  );
  for (const row of result.materialize) {
    if (row.status === "up-to-date" || row.status === "created" || row.status === "updated") continue;
    console.log(`  ${row.status} ${row.skill.key}${row.note ? ` — ${row.note}` : ""}`);
  }

  const verb = opts.dryRun ? "would link" : "linked";
  for (const summary of result.links) {
    console.log(
      `${summary.tool}: ${verb}=${summary.linked.length} adopted=${summary.adopted.length} repointed=${summary.repointed.length} unchanged=${summary.skipped.length} removed=${summary.removed.length} failed=${summary.failed.length} target=${summary.target}`,
    );
    for (const repoint of summary.repointed) {
      console.log(`  repointed ${repoint.name}: ${repoint.from} -> ${repoint.to}`);
    }
    for (const shadow of summary.shadowed) {
      console.log(`  shadowed ${shadow.name}: ${shadow.winner} wins over ${shadow.loser}`);
    }
    for (const conflict of summary.conflicts) {
      console.log(`  conflict ${conflict.name}: ${conflict.reason}`);
    }
    for (const failed of summary.failed) {
      console.log(`  failed ${failed.name}: ${failed.error}`);
    }
  }

  for (const row of result.repoPrune) {
    console.log(`prune ${row.action} ${result.teamDir}/${row.name}${row.reason ? ` — ${row.reason}` : ""}`);
  }
  for (const row of result.terminalPrune) {
    console.log(`prune ${row.action} ${row.target}/${row.name} (dead link into ${row.linkedTo})`);
  }
  if (!opts.pruneApply && (result.repoPrune.length > 0 || result.terminalPrune.length > 0)) {
    console.log("Pruning is a report by default. Re-run with --prune-apply to delete.");
  }
}
