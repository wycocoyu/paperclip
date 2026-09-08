import { detectSkillDirDrift } from "@paperclipai/skill-materializer";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedClientContext } from "./common.js";
import {
  TEAM_SKILLS_DIRNAME,
  inspectSkillLink,
  terminalSkillTargets,
  type TerminalSkillTool,
} from "./skill-links.js";
import { readSidecar } from "./skill-materialize.js";

/** One fan-out delivery the server parked after exhausting its retries. */
interface SkillFanoutFailure {
  skillId: string;
  lastError: string;
  attempts: number;
  lastAttemptAt: string;
}

/**
 * Never "no failures" when the question was not answered: an unreachable server
 * and a clean failure list mean opposite things to whoever reads the column.
 */
export type FanoutFailureLookup =
  | { available: true; bySkillId: Map<string, SkillFanoutFailure> }
  | { available: false; reason: string };

export interface SkillStatusRow {
  name: string;
  source: string;
  sourceLabel: "team" | "upstream";
  skillId: string | null;
  /** Link state per terminal, keyed by tool; `to` is set once the link resolves. */
  links: Record<TerminalSkillTool, { state: string; to?: string }>;
  /** Human-readable drift description, null when clean, undefined when unknowable. */
  drift: string | null | undefined;
  fanout: SkillFanoutFailure | null | "unknown";
}

export interface SkillsStatusResult {
  repoRoot: string;
  tools: TerminalSkillTool[];
  fanoutAvailable: boolean;
  fanoutReason?: string;
  skills: SkillStatusRow[];
}

async function listSkillDirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export async function fetchFanoutFailures(ctx: ResolvedClientContext): Promise<FanoutFailureLookup> {
  try {
    const body = await ctx.api.get<{ failures?: SkillFanoutFailure[] }>(
      `/api/companies/${ctx.companyId}/skills/fanout-failures`,
    );
    // A 200 that carries no `failures` array is a route that answered something
    // else (an older server, a proxy) — not an empty failure list.
    if (!body || !Array.isArray(body.failures)) {
      return { available: false, reason: "server returned no failures list (route missing?)" };
    }
    const bySkillId = new Map(body.failures.map((failure) => [failure.skillId, failure]));
    return { available: true, bySkillId };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function collectSkillsStatus(
  ctx: ResolvedClientContext,
  repoRoot: string,
): Promise<SkillsStatusResult> {
  const targets = terminalSkillTargets();
  const fanout = await fetchFanoutFailures(ctx);

  // Same precedence `skills pull` links by: the team checkout claims a slug
  // first, upstream only fills what team does not carry.
  const sources: Array<{ dir: string; label: "team" | "upstream" }> = [
    { dir: path.join(repoRoot, TEAM_SKILLS_DIRNAME), label: "team" },
    { dir: path.join(repoRoot, "skills"), label: "upstream" },
  ];

  const claimed = new Map<string, { dir: string; label: "team" | "upstream" }>();
  for (const source of sources) {
    for (const name of await listSkillDirs(source.dir)) {
      if (!claimed.has(name)) claimed.set(name, source);
    }
  }

  const rows: SkillStatusRow[] = [];
  for (const name of [...claimed.keys()].sort()) {
    const source = claimed.get(name)!;
    const skillDir = path.join(source.dir, name);
    const sidecar = await readSidecar(skillDir);

    const links = {} as Record<TerminalSkillTool, { state: string; to?: string }>;
    for (const target of targets) {
      const inspection = await inspectSkillLink(path.join(target.dir, name), skillDir);
      links[target.tool] = { state: inspection.state, ...(inspection.linkedTo ? { to: inspection.linkedTo } : {}) };
    }

    rows.push({
      name,
      source: skillDir,
      sourceLabel: source.label,
      skillId: sidecar?.skillId ?? null,
      links,
      // Only a sidecar records what the last sync wrote; an upstream directory
      // tracked by git has no such baseline, so drift there is git's question.
      drift: sidecar ? await detectSkillDirDrift(skillDir, sidecar) : undefined,
      fanout: !fanout.available
        ? "unknown"
        : sidecar?.skillId
          ? (fanout.bySkillId.get(sidecar.skillId) ?? null)
          : null,
    });
  }

  return {
    repoRoot,
    tools: targets.map((target) => target.tool),
    fanoutAvailable: fanout.available,
    ...(fanout.available ? {} : { fanoutReason: fanout.reason }),
    skills: rows,
  };
}

const LINK_GLYPH: Record<string, string> = {
  correct: "o",
  absent: "-",
  dangling: "!",
  elsewhere: "~",
  occupied: "x",
};

/** Distinct parent directories that `elsewhere` links resolve into, with counts. */
export function foreignLinkRoots(result: SkillsStatusResult): Array<[string, number]> {
  const roots = new Map<string, number>();
  for (const row of result.skills) {
    for (const tool of result.tools) {
      const link = row.links[tool];
      if (link.state !== "elsewhere" || !link.to) continue;
      const root = path.dirname(link.to);
      roots.set(root, (roots.get(root) ?? 0) + 1);
    }
  }
  return [...roots.entries()].sort((a, b) => b[1] - a[1]);
}

export function printSkillsStatus(result: SkillsStatusResult): void {
  const nameWidth = Math.max(6, ...result.skills.map((row) => row.name.length));
  const header = [
    "skill".padEnd(nameWidth),
    ...result.tools.map((tool) => tool.padEnd(6)),
    "drift".padEnd(6),
    "fanout",
  ].join(" ");
  console.log(header);

  for (const row of result.skills) {
    const cells = result.tools.map((tool) => (LINK_GLYPH[row.links[tool].state] ?? "?").padEnd(6));
    const drift = row.drift === undefined ? "n/a" : row.drift ? "DRIFT" : "-";
    const fanout =
      row.fanout === "unknown" ? "unknown" : row.fanout ? `FAILED(${row.fanout.attempts})` : "-";
    console.log([row.name.padEnd(nameWidth), ...cells, drift.padEnd(6), fanout].join(" "));
  }

  const drifted = result.skills.filter((row) => row.drift);
  for (const row of drifted) console.log(`  ${row.name}: ${row.drift}`);

  // Every `~` at once usually means one thing — the terminals are linked to a
  // different checkout of the same skills — and 23 identical rows do not say
  // so. Naming the roots turns "all broken" back into "linked elsewhere".
  for (const [root, count] of foreignLinkRoots(result)) {
    console.log(`  ${count} link(s) point into another checkout: ${root}`);
  }
  if (!result.fanoutAvailable) {
    console.log(`fanout failures unknown: ${result.fanoutReason ?? "server unreachable"}`);
  }
  console.log(
    `legend: o=linked -=absent !=dangling ~=points elsewhere x=real directory; ${result.skills.length} skill(s) under ${result.repoRoot}`,
  );
}
