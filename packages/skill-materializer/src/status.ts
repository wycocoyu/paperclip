import fs from "node:fs/promises";
import path from "node:path";
import { detectSkillDirDrift } from "./materialize.js";
import { readSidecar } from "./sidecar.js";
import {
  TEAM_SKILLS_DIRNAME,
  inspectSkillLink,
  terminalSkillTargets,
  type TerminalSkillTool,
} from "./terminals.js";

/** One fan-out delivery the server parked after exhausting its retries. */
export interface SkillFanoutFailure {
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

/**
 * The fan-out lookup is injected rather than fetched: the CLI asks the server
 * over HTTP, the server reads its own in-memory list. One collector, one shape
 * of answer, no second parser to drift from this one.
 */
export async function collectSkillsStatus(opts: {
  repoRoot: string;
  fanout: FanoutFailureLookup;
}): Promise<SkillsStatusResult> {
  const targets = terminalSkillTargets();
  const { repoRoot, fanout } = opts;

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
