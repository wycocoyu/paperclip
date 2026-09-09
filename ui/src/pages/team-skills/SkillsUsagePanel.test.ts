import { describe, expect, it } from "vitest";
import { filterToTeamSkills, type SkillLibraryEntry } from "./SkillsUsagePanel";
import type { SkillUsageRow } from "@/api/skillsTelemetry";

function row(skill: string, total = 1): SkillUsageRow {
  return { skill, total, byHarness: { claude: total, codex: 0, zcode: 0 } };
}

const LIBRARY: SkillLibraryEntry[] = [
  { name: "team-grilling", slug: "team-grilling" },
  // The library's own two spellings disagree in case for this one.
  { name: "Team-handoff", slug: "team-handoff" },
];

describe("filterToTeamSkills", () => {
  it("drops built-ins, plugins, local-only skills, and bundled library entries we cannot edit", () => {
    // `paperclip` is in the company library but is a read-only `paperclipai/*`
    // entry, so the caller leaves it out of `library` and it must not show.
    const rows = [
      row("team-grilling"),
      row("dataviz"),
      row("superpowers:brainstorming"),
      row("zz-team"),
      row("team-orchestration"),
      row("paperclip"),
    ];
    expect(filterToTeamSkills(rows, LIBRARY).map((r) => r.skill)).toEqual(["team-grilling"]);
  });

  it("keeps every case variant of one library skill, matching either name or slug", () => {
    const rows = [row("Team-handoff"), row("team-handoff"), row("TEAM-GRILLING")];
    expect(filterToTeamSkills(rows, LIBRARY).map((r) => r.skill)).toEqual([
      "Team-handoff",
      "team-handoff",
      "TEAM-GRILLING",
    ]);
  });

  it("keeps the rows untouched — the toggle changes which rows show, not their counts", () => {
    const kept = row("team-grilling", 42);
    expect(filterToTeamSkills([kept, row("dataviz", 99)], LIBRARY)).toEqual([kept]);
  });

  it("hides everything rather than showing everything when the library is empty", () => {
    expect(filterToTeamSkills([row("team-grilling")], [])).toEqual([]);
  });
});
