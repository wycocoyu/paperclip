import type { SkillsUsageResult } from "@paperclipai/skill-materializer";

// The scanner itself lives in the shared materializer package: the UI reads the
// same numbers through the server, and two parsers of these transcripts would
// be two answers to "how often was this skill called".
export {
  collectSkillsUsage,
  extractCodexSkillReads,
  extractSkillCalls,
  harnessSources,
  usageCachePath,
  type SkillUsageRow,
  type SkillsUsageOptions,
  type SkillsUsageResult,
  type UsageHarness,
} from "@paperclipai/skill-materializer";

/**
 * The two columns are not the same measurement, and a reader who assumes they
 * are will draw the wrong conclusion from the sum. Say it under the table.
 */
export const CODEX_CALIBER_NOTE =
  "the two columns count different things: claude/zcode count explicit Skill tool calls (N per session), codex has no Skill tool and counts sessions that read the skill's SKILL.md (once per session, however many reads). Magnitudes are comparable; the units are not.";

export function printSkillsUsage(result: SkillsUsageResult): void {
  const nameWidth = Math.max(6, ...result.skills.map((row) => row.skill.length));
  console.log(
    ["skill".padEnd(nameWidth), "total".padStart(6), "claude".padStart(7), "codex".padStart(6), "zcode".padStart(6)].join(" "),
  );
  for (const row of result.skills) {
    console.log(
      [
        row.skill.padEnd(nameWidth),
        String(row.total).padStart(6),
        String(row.byHarness.claude).padStart(7),
        String(row.byHarness.codex).padStart(6),
        String(row.byHarness.zcode).padStart(6),
      ].join(" "),
    );
  }
  const files = Object.values(result.scanned).reduce((sum, entry) => sum + entry.files, 0);
  const parsed = Object.values(result.scanned).reduce((sum, entry) => sum + entry.parsed, 0);
  console.log(
    `${result.skills.length} skill(s), ${result.totalCalls} call(s) since ${result.since} — ${files} session file(s) in window, ${parsed} parsed (rest cached)`,
  );
  if (result.unreadable.length > 0) {
    console.log(`${result.unreadable.length} session file(s) unreadable; counts below the truth:`);
    for (const entry of result.unreadable) console.log(`  ${entry.file}: ${entry.error}`);
  }
  console.log(`note: ${CODEX_CALIBER_NOTE}`);
}
