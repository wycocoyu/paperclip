import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectSkillsUsage,
  extractCodexSkillReads,
  extractSkillCalls,
  harnessSources,
} from "../commands/client/skills-usage.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 7);

async function writeJsonl(file: string, records: unknown[], mtimeMs: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
  const when = new Date(mtimeMs);
  await fs.utimes(file, when, when);
}

/** One Codex exec record, shaped like the `parsed_cmd` its rollout log writes. */
function codexRead(skillPath: string): unknown {
  return {
    type: "event_msg",
    payload: {
      command: ["/bin/zsh", "-lc", `sed -n '1,240p' ${skillPath}`],
      parsed_cmd: [
        { type: "read", cmd: `sed -n '1,240p' ${skillPath}`, name: "SKILL.md", path: skillPath },
      ],
    },
  };
}

function claudeCall(id: string, skill: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "assistant",
    ...extra,
    message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] },
  };
}

describe("skills usage", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "skills-usage-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("reads ZCode transcripts from the CLI rollout logs, not the ~/.agents skills dir", () => {
    const sources = harnessSources();
    expect(sources.zcode).toEqual([
      path.join(home, ".zcode", "cli", "rollout"),
      path.join(home, ".zcode", "cli", "agents"),
    ]);
    expect(sources.zcode.some((dir) => dir.includes(`${path.sep}.agents`))).toBe(false);
  });

  it("counts only explicit Skill tool calls, ignoring reads of the skill body", () => {
    const readInstead = {
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x/team-grilling/SKILL.md" } },
          { type: "text", text: "the Skill listing mentions team-grilling" },
        ],
      },
    };
    expect(extractSkillCalls(readInstead)).toEqual([]);
    expect(extractSkillCalls(claudeCall("t2", "team-grilling"))).toEqual([
      { id: "t2", skill: "team-grilling" },
    ]);
  });

  it("counts repeat calls of one skill but collapses a replayed transcript by call id", async () => {
    // ZCode's model-io log re-emits the whole conversation on every request, so
    // one call shows up in many records; two distinct ids are two calls.
    await writeJsonl(
      path.join(home, ".zcode", "cli", "rollout", "model-io-sess_a.jsonl"),
      [
        { input: [{ type: "tool_use", id: "call_1", name: "Skill", input: { skill: "paperclip" } }] },
        {
          input: [
            { type: "tool_use", id: "call_1", name: "Skill", input: { skill: "paperclip" } },
            { type: "tool_use", id: "call_2", name: "Skill", input: { skill: "paperclip" } },
          ],
        },
      ],
      NOW - DAY,
    );

    const result = await collectSkillsUsage({ days: 30, cache: false, now: () => NOW });
    expect(result.skills).toEqual([
      { skill: "paperclip", total: 2, byHarness: { claude: 0, codex: 0, zcode: 2 } },
    ]);
  });

  it("takes a Codex skill name from the directory holding SKILL.md, whatever the root", () => {
    expect(
      extractCodexSkillReads(codexRead("/Users/x/.codex/skills/.system/imagegen/SKILL.md")),
    ).toEqual(["imagegen"]);
    expect(extractCodexSkillReads(codexRead("skills/handle/SKILL.md"))).toEqual(["handle"]);
    // A SKILL.md path echoed by some other tool's output is not a read of it.
    expect(
      extractCodexSkillReads({ enrichedPaths: [{ path: "coco-knowledge/SKILL.md" }] }),
    ).toEqual([]);
    // Nor is writing one.
    expect(
      extractCodexSkillReads({ parsed_cmd: [{ type: "write", name: "SKILL.md", path: "a/b/SKILL.md" }] }),
    ).toEqual([]);
  });

  it("scores a Codex skill once per session however many times the session re-reads it", async () => {
    const skill = "/Users/x/.codex/skills/team-grilling/SKILL.md";
    await writeJsonl(
      path.join(home, ".codex", "sessions", "2026", "09", "sess-a.jsonl"),
      [codexRead(skill), codexRead(skill), codexRead(skill)],
      NOW - DAY,
    );
    await writeJsonl(
      path.join(home, ".codex", "sessions", "2026", "09", "sess-b.jsonl"),
      [codexRead(skill)],
      NOW - DAY,
    );

    const result = await collectSkillsUsage({ days: 30, cache: false, now: () => NOW });
    expect(result.skills).toEqual([
      { skill: "team-grilling", total: 2, byHarness: { claude: 0, codex: 2, zcode: 0 } },
    ]);
  });

  it("leaves the Claude and ZCode columns on explicit Skill calls only", async () => {
    // The same read that counts for Codex must stay invisible in the other two.
    await writeJsonl(
      path.join(home, ".claude", "projects", "-repo", "sess.jsonl"),
      [codexRead("/Users/x/.codex/skills/team-grilling/SKILL.md")],
      NOW - DAY,
    );
    await writeJsonl(
      path.join(home, ".zcode", "cli", "rollout", "model-io-sess.jsonl"),
      [codexRead("/Users/x/.codex/skills/team-grilling/SKILL.md")],
      NOW - DAY,
    );

    const result = await collectSkillsUsage({ days: 30, cache: false, now: () => NOW });
    expect(result.totalCalls).toBe(0);
  });

  it("counts sub-agent transcripts and groups totals by harness", async () => {
    const project = path.join(home, ".claude", "projects", "-repo");
    await writeJsonl(path.join(project, "sess.jsonl"), [claudeCall("t1", "team-grilling")], NOW - DAY);
    await writeJsonl(
      path.join(project, "sess", "subagents", "agent-1.jsonl"),
      [claudeCall("t2", "team-grilling", { isSidechain: true })],
      NOW - DAY,
    );
    await writeJsonl(
      path.join(home, ".zcode", "cli", "agents", "sess_x", "agent_y", "transcript.jsonl"),
      [{ id: "call_9", name: "Skill", input: { skill: "team-grilling" } }],
      NOW - DAY,
    );

    const result = await collectSkillsUsage({ days: 30, cache: false, now: () => NOW });
    expect(result.totalCalls).toBe(3);
    expect(result.skills[0]).toEqual({
      skill: "team-grilling",
      total: 3,
      byHarness: { claude: 2, codex: 0, zcode: 1 },
    });
  });

  it("excludes session files last written outside the --days window", async () => {
    const project = path.join(home, ".claude", "projects", "-repo");
    await writeJsonl(path.join(project, "recent.jsonl"), [claudeCall("t1", "inside")], NOW - 2 * DAY);
    await writeJsonl(path.join(project, "old.jsonl"), [claudeCall("t2", "outside")], NOW - 40 * DAY);

    const result = await collectSkillsUsage({ days: 30, cache: false, now: () => NOW });
    expect(result.skills.map((row) => row.skill)).toEqual(["inside"]);
    expect(result.scanned.claude).toEqual({ files: 1, parsed: 1 });
  });

  it("reuses the cache for unchanged files and re-parses a file that grew", async () => {
    const file = path.join(home, ".claude", "projects", "-repo", "sess.jsonl");
    await writeJsonl(file, [claudeCall("t1", "team-grilling")], NOW - DAY);

    const cold = await collectSkillsUsage({ days: 30, cache: true, now: () => NOW });
    expect(cold.scanned.claude.parsed).toBe(1);

    const warm = await collectSkillsUsage({ days: 30, cache: true, now: () => NOW });
    expect(warm.scanned.claude).toEqual({ files: 1, parsed: 0 });
    expect(warm.totalCalls).toBe(1);

    await writeJsonl(
      file,
      [claudeCall("t1", "team-grilling"), claudeCall("t2", "team-handoff")],
      NOW - DAY / 2,
    );
    const after = await collectSkillsUsage({ days: 30, cache: true, now: () => NOW });
    expect(after.scanned.claude.parsed).toBe(1);
    expect(after.totalCalls).toBe(2);
  });

  it("keeps out-of-window cache entries so a narrow window does not evict a wide one's work", async () => {
    const old = path.join(home, ".claude", "projects", "-repo", "old.jsonl");
    await writeJsonl(old, [claudeCall("t1", "team-grilling")], NOW - 20 * DAY);

    const wide = await collectSkillsUsage({ days: 30, cache: true, now: () => NOW });
    expect(wide.scanned.claude.parsed).toBe(1);

    // A 7-day scan must not see the file, and must not drop its cache entry.
    const narrow = await collectSkillsUsage({ days: 7, cache: true, now: () => NOW });
    expect(narrow.totalCalls).toBe(0);

    const again = await collectSkillsUsage({ days: 30, cache: true, now: () => NOW });
    expect(again.scanned.claude).toEqual({ files: 1, parsed: 0 });
    expect(again.totalCalls).toBe(1);
  });

  it("reports an unreadable session file instead of counting it as zero calls", async () => {
    const dir = path.join(home, ".claude", "projects", "-repo");
    const file = path.join(dir, "sess.jsonl");
    await writeJsonl(file, [claudeCall("t1", "team-grilling")], NOW - DAY);
    await fs.chmod(file, 0o000);

    try {
      const result = await collectSkillsUsage({ days: 30, cache: false, now: () => NOW });
      expect(result.unreadable).toHaveLength(1);
      expect(result.unreadable[0]?.file).toBe(file);
      expect(result.totalCalls).toBe(0);
    } finally {
      await fs.chmod(file, 0o600);
    }
  });
});
