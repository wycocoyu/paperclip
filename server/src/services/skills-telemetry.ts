import {
  collectSkillsStatus,
  collectSkillsUsage,
  resolvePaperclipRepoRoot,
  type SkillsStatusResult,
  type SkillsUsageResult,
} from "@paperclipai/skill-materializer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillFanoutFailures, skillFanoutProjection } from "./skill-fanout.js";

/**
 * Read-only view of this machine's skill telemetry, for the Team Skills page.
 *
 * The collectors are the CLI's (`paperclipai skills usage` / `skills status`)
 * verbatim — server and terminals share a host, so the same transcripts and the
 * same symlinks answer both. Two scanners would be two answers.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// A cold usage scan walks every transcript on the box (~22s here); a warm one
// still stats a few thousand files. The page must not pay either on each open,
// so an answer is reused for this long and concurrent openers share one scan.
const USAGE_TTL_MS = 60_000;

interface UsageEntry {
  at: number;
  result: SkillsUsageResult;
}

const usageByDays = new Map<number, UsageEntry>();
const usageInFlight = new Map<number, Promise<SkillsUsageResult>>();

export function skillsUsageCacheReset(): void {
  usageByDays.clear();
  usageInFlight.clear();
}

/**
 * `refresh` is the page's Refresh button and the CLI's `--no-cache`: it skips
 * the TTL above *and* the on-disk per-file cache, so a scan that some other
 * process warmed is not what the reader gets back. It also skips the in-flight
 * share — joining a scan already running under the old caches would answer a
 * refresh with the very numbers it was asked to bypass.
 */
export async function skillsUsage(
  days: number,
  now = Date.now(),
  opts: { refresh?: boolean } = {},
): Promise<SkillsUsageResult> {
  if (!opts.refresh) {
    const fresh = usageByDays.get(days);
    if (fresh && now - fresh.at < USAGE_TTL_MS) return fresh.result;

    const running = usageInFlight.get(days);
    if (running) return running;
  }

  // `cache: true` shares ~/.paperclip/skills-usage-cache.json with the CLI: the
  // per-file entries are keyed by mtime+size, so whichever process parsed a
  // transcript first spares the other.
  // Stamped with the clock the request came in on, so the window is bounded from
  // the moment the scan started rather than whenever it happened to finish.
  const scan = collectSkillsUsage({ days, cache: !opts.refresh }).then((result) => {
    usageByDays.set(days, { at: now, result });
    return result;
  });
  // A refresh stays out of the shared slot in both directions: it must not be
  // handed to a plain reader that asked for a cached answer, and its `finally`
  // must not evict a plain scan that is still running under the same key.
  if (!opts.refresh) {
    usageInFlight.set(days, scan);
    void scan.finally(() => usageInFlight.delete(days)).catch(() => {});
  }
  return scan;
}

export async function skillsLocalStatus(companyId: string): Promise<SkillsStatusResult | null> {
  // Answer about the checkout fan-out actually writes into. Walking up from the
  // module only finds one when the server runs from a repo, which is exactly the
  // case PAPERCLIP_SKILLS_TEAM_DIR exists to cover.
  const projection = skillFanoutProjection();
  const repoRoot = projection
    ? path.dirname(projection.dir)
    : await resolvePaperclipRepoRoot([moduleDir, process.cwd()]);
  // No checkout means no `skills-team/` to inspect; the route says so rather
  // than reporting an empty — and therefore clean — projection table.
  if (!repoRoot) return null;
  return collectSkillsStatus({
    repoRoot,
    fanout: {
      available: true,
      bySkillId: new Map(skillFanoutFailures(companyId).map((failure) => [failure.skillId, failure])),
    },
  });
}
