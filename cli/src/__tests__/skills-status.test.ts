import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedClientContext } from "../commands/client/common.js";
import { collectSkillsStatus, foreignLinkRoots } from "../commands/client/skills-status.js";

const SKILL_ID = "11111111-2222-3333-4444-555555555555";

let root: string;
let home: string;

function ctxWith(get: (url: string) => Promise<unknown>): ResolvedClientContext {
  return { api: { get }, companyId: "co-1", json: false } as unknown as ResolvedClientContext;
}

async function seedTeamSkill(name: string, body: string): Promise<void> {
  const dir = path.join(root, "skills-team", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
  // A sidecar recording the hash of exactly what we just wrote is what the
  // shared materializer compares against; without one there is no baseline.
  const { hashFileMap } = await import("@paperclipai/skill-materializer");
  const files = new Map([["SKILL.md", body]]);
  await fs.writeFile(
    path.join(dir, ".paperclip-skill.json"),
    JSON.stringify({
      skillId: SKILL_ID,
      key: name,
      remoteHash: hashFileMap(files),
      localHash: hashFileMap(files),
      syncedAt: new Date().toISOString(),
      currentVersionId: null,
      updatedAt: new Date().toISOString(),
      files: ["SKILL.md"],
      lastChangedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

describe("skills status", () => {
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-status-root-")));
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-status-home-")));
    await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(home);
    for (const key of ["CODEX_HOME", "CLAUDE_HOME", "KIMI_CODE_HOME", "ZCODE_HOME", "CURSOR_HOME"]) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it("reports the projection state of all five terminals", async () => {
    await seedTeamSkill("team-grilling", "# grill\n");
    const source = path.join(root, "skills-team", "team-grilling");
    const claudeSkills = path.join(home, ".claude", "skills");
    await fs.mkdir(claudeSkills, { recursive: true });
    await fs.symlink(source, path.join(claudeSkills, "team-grilling"));

    const result = await collectSkillsStatus(ctxWith(async () => ({ failures: [] })), root);
    expect(result.tools).toEqual(["codex", "claude", "kimi", "zcode", "cursor"]);
    const row = result.skills.find((entry) => entry.name === "team-grilling")!;
    expect(row.links.claude.state).toBe("correct");
    expect(row.links.codex.state).toBe("absent");
    expect(row.links.cursor.state).toBe("absent");
  });

  it("flags a locally edited skill and clears the flag once it is restored", async () => {
    await seedTeamSkill("team-grilling", "# grill\n");
    const skillFile = path.join(root, "skills-team", "team-grilling", "SKILL.md");
    const clean = await collectSkillsStatus(ctxWith(async () => ({ failures: [] })), root);
    expect(clean.skills.find((row) => row.name === "team-grilling")?.drift).toBeNull();

    await fs.appendFile(skillFile, "# probe\n", "utf8");
    const dirty = await collectSkillsStatus(ctxWith(async () => ({ failures: [] })), root);
    expect(dirty.skills.find((row) => row.name === "team-grilling")?.drift).toBe(
      "local edits since last sync",
    );

    await fs.writeFile(skillFile, "# grill\n", "utf8");
    const restored = await collectSkillsStatus(ctxWith(async () => ({ failures: [] })), root);
    expect(restored.skills.find((row) => row.name === "team-grilling")?.drift).toBeNull();
  });

  it("degrades the fan-out column to unknown when the route is missing, not to no-failures", async () => {
    await seedTeamSkill("team-grilling", "# grill\n");
    const missing = await collectSkillsStatus(
      ctxWith(async () => {
        throw new Error("Skill not found");
      }),
      root,
    );
    expect(missing.fanoutAvailable).toBe(false);
    expect(missing.fanoutReason).toContain("Skill not found");
    expect(missing.skills[0]?.fanout).toBe("unknown");

    // A 200 that answers with something other than a failures array is the same
    // unknown — an older server, or a route captured by :skillId.
    const wrongShape = await collectSkillsStatus(ctxWith(async () => ({ id: "some-skill" })), root);
    expect(wrongShape.fanoutAvailable).toBe(false);
    expect(wrongShape.skills[0]?.fanout).toBe("unknown");

    const clean = await collectSkillsStatus(ctxWith(async () => ({ failures: [] })), root);
    expect(clean.fanoutAvailable).toBe(true);
    expect(clean.skills[0]?.fanout).toBeNull();
  });

  it("matches a reported failure to its skill by the sidecar's skill id", async () => {
    await seedTeamSkill("team-grilling", "# grill\n");
    const result = await collectSkillsStatus(
      ctxWith(async () => ({
        failures: [
          { skillId: SKILL_ID, lastError: "drift conflict", attempts: 3, lastAttemptAt: "2026-09-07T00:00:00Z" },
        ],
      })),
      root,
    );
    expect(result.skills[0]?.fanout).toMatchObject({ attempts: 3, lastError: "drift conflict" });
  });

  it("names the checkout a link points into so a foreign root does not read as broken", async () => {
    await seedTeamSkill("team-grilling", "# grill\n");
    const other = path.join(root, "other-checkout", "skills-team", "team-grilling");
    await fs.mkdir(other, { recursive: true });
    const claudeSkills = path.join(home, ".claude", "skills");
    await fs.mkdir(claudeSkills, { recursive: true });
    await fs.symlink(other, path.join(claudeSkills, "team-grilling"));

    const result = await collectSkillsStatus(ctxWith(async () => ({ failures: [] })), root);
    expect(result.skills[0]?.links.claude.state).toBe("elsewhere");
    expect(foreignLinkRoots(result)).toEqual([[path.dirname(other), 1]]);
  });

  it("leaves drift unknown for an upstream skill that carries no sidecar baseline", async () => {
    const dir = path.join(root, "skills", "upstream-only");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "# upstream\n", "utf8");

    const result = await collectSkillsStatus(ctxWith(async () => ({ failures: [] })), root);
    const row = result.skills.find((entry) => entry.name === "upstream-only")!;
    expect(row.sourceLabel).toBe("upstream");
    expect(row.drift).toBeUndefined();
    expect(row.skillId).toBeNull();
  });
});
