import {
  collectSkillsStatus as collectStatus,
  foreignLinkRoots,
  type FanoutFailureLookup,
  type SkillFanoutFailure,
  type SkillsStatusResult,
} from "@paperclipai/skill-materializer";
import type { ResolvedClientContext } from "./common.js";

// The projection/drift walk lives in the shared materializer package so the
// server's read-only status route answers from the same code; the CLI keeps
// only what needs a client context (the fan-out list) and the printer.
export {
  foreignLinkRoots,
  type FanoutFailureLookup,
  type SkillFanoutFailure,
  type SkillStatusRow,
  type SkillsStatusResult,
} from "@paperclipai/skill-materializer";

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
  return collectStatus({ repoRoot, fanout: await fetchFanoutFailures(ctx) });
}

const LINK_GLYPH: Record<string, string> = {
  correct: "o",
  absent: "-",
  dangling: "!",
  elsewhere: "~",
  occupied: "x",
};

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
