import { Command } from "commander";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsCommands } from "../commands/client/skills.js";
import type { ResolvedClientContext } from "../commands/client/common.js";
import { hashFileMap } from "../commands/client/skill-files.js";
import {
  materializeCompanySkills,
  readSidecar,
  type SkillMaterializeRow,
} from "../commands/client/skill-materialize.js";
import {
  acquireSkillsPullLock,
  projectedTeamSkillNames,
  pruneTeamSkillDirs,
  runSkillsPull,
  skillsPullLockPath,
} from "../commands/client/skills-pull.js";

const ORIGINAL_ENV = { ...process.env };

let root: string;
let teamDir: string;
let apiGet: ReturnType<typeof vi.fn>;

interface LibrarySkill {
  id: string;
  slug: string;
  currentVersionId: string | null;
  updatedAt: string;
  files: Record<string, string>;
}

function library(...skills: LibrarySkill[]) {
  return skills;
}

// Stands in for the HTTP client so tests can count exactly which per-skill
// endpoints a pull touches.
function makeContext(skills: LibrarySkill[]): ResolvedClientContext {
  apiGet = vi.fn(async (url: string) => {
    if (url === "/api/companies/company-1/skills") {
      return skills.map((skill) => ({
        id: skill.id,
        companyId: "company-1",
        key: `paperclip/${skill.slug}`,
        slug: skill.slug,
        name: skill.slug,
        currentVersionId: skill.currentVersionId,
        updatedAt: skill.updatedAt,
      }));
    }
    const match = /^\/api\/companies\/company-1\/skills\/([^/]+)\/versions$/.exec(url);
    if (match) {
      const skill = skills.find((entry) => entry.id === match[1]);
      return [
        {
          id: skill?.currentVersionId ?? "v0",
          revisionNumber: 1,
          fileInventory: Object.entries(skill?.files ?? {}).map(([filePath, content]) => ({
            path: filePath,
            kind: "skill",
            content,
          })),
        },
      ];
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return { api: { get: apiGet }, companyId: "company-1", json: false } as unknown as ResolvedClientContext;
}

function versionsCalls(): number {
  return apiGet.mock.calls.filter((call) => String(call[0]).endsWith("/versions")).length;
}

async function pull(skills: LibrarySkill[], overrides: Partial<{ force: boolean; dryRun: boolean }> = {}) {
  return materializeCompanySkills(makeContext(skills), {
    target: [teamDir],
    skill: [],
    dryRun: overrides.dryRun ?? false,
    force: overrides.force ?? false,
  });
}

function statusOf(rows: SkillMaterializeRow[], slug: string): string | undefined {
  return rows.find((row) => row.skill.slug === slug)?.status;
}

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-pull-"));
  teamDir = path.join(root, "skills-team");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("materialize change detection", () => {
  const base: LibrarySkill = {
    id: "skill-1",
    slug: "review-prs",
    currentVersionId: "v1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    files: { "SKILL.md": "# v1" },
  };

  it("skips the per-skill fetch once both change markers are recorded", async () => {
    expect(statusOf(await pull(library(base)), "review-prs")).toBe("created");
    expect(versionsCalls()).toBe(1);

    const rows = await pull(library(base));

    expect(statusOf(rows, "review-prs")).toBe("up-to-date");
    expect(versionsCalls()).toBe(0);
  });

  it("still short-circuits a skill the server leaves unversioned", async () => {
    const unversioned = { ...base, currentVersionId: null };
    expect(statusOf(await pull(library(unversioned)), "review-prs")).toBe("created");

    const rows = await pull(library(unversioned));

    expect(statusOf(rows, "review-prs")).toBe("up-to-date");
    expect(versionsCalls()).toBe(0);
  });

  it("refetches when updatedAt moves even though currentVersionId is null", async () => {
    await pull(library({ ...base, currentVersionId: null }));

    const rows = await pull(
      library({
        ...base,
        currentVersionId: null,
        updatedAt: "2026-08-02T00:00:00.000Z",
        files: { "SKILL.md": "# v2" },
      }),
    );

    expect(versionsCalls()).toBe(1);
    expect(statusOf(rows, "review-prs")).toBe("updated");
    expect(await fs.readFile(path.join(teamDir, "review-prs", "SKILL.md"), "utf8")).toBe("# v2");
  });

  it("freezes lastChangedAt but records the new markers when the bytes did not move", async () => {
    await pull(library(base));
    const created = await readSidecar(path.join(teamDir, "review-prs"));
    const touched = { ...base, currentVersionId: "v2", updatedAt: "2026-08-03T00:00:00.000Z" };

    const rows = await pull(library(touched));
    expect(versionsCalls()).toBe(1);
    expect(statusOf(rows, "review-prs")).toBe("up-to-date");
    const after = await readSidecar(path.join(teamDir, "review-prs"));
    expect(after?.lastChangedAt).toBe(created?.lastChangedAt);
    expect(after?.currentVersionId).toBe("v2");

    await pull(library(touched));
    expect(versionsCalls()).toBe(0);
  });
});

describe("sidecar lastChangedAt", () => {
  const base: LibrarySkill = {
    id: "skill-1",
    slug: "review-prs",
    currentVersionId: "v1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    files: { "SKILL.md": "# v1" },
  };

  it("holds still across an unchanged pull and moves only when the content changes", async () => {
    await pull(library(base));
    const created = await readSidecar(path.join(teamDir, "review-prs"));

    await pull(library(base));
    const unchanged = await readSidecar(path.join(teamDir, "review-prs"));
    expect(unchanged?.lastChangedAt).toBe(created?.lastChangedAt);
    expect(unchanged?.syncedAt).toBe(created?.syncedAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await pull(
      library({ ...base, currentVersionId: "v2", updatedAt: "2026-08-02T00:00:00.000Z", files: { "SKILL.md": "# v2" } }),
    );
    const updated = await readSidecar(path.join(teamDir, "review-prs"));
    expect(Date.parse(updated?.lastChangedAt ?? "")).toBeGreaterThan(
      Date.parse(created?.lastChangedAt ?? ""),
    );
  });

  it("upgrades a pre-tracking sidecar without inventing a change time", async () => {
    const skillDir = path.join(teamDir, "review-prs");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# v1", "utf8");
    const legacyHash = hashFileMap(new Map([["SKILL.md", "# v1"]]));
    await fs.writeFile(
      path.join(skillDir, ".paperclip-skill.json"),
      JSON.stringify({
        skillId: "skill-1",
        key: "paperclip/review-prs",
        remoteHash: legacyHash,
        localHash: legacyHash,
        syncedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const rows = await pull(library(base));

    expect(statusOf(rows, "review-prs")).toBe("up-to-date");
    const sidecar = await readSidecar(skillDir);
    expect(sidecar?.lastChangedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(sidecar?.files).toEqual(["SKILL.md"]);
    expect(sidecar?.currentVersionId).toBe("v1");
  });
});

describe("sidecar in the remote snapshot", () => {
  // Snapshots taken before the server skipped the sidecar carry it as a file.
  // The client never reads it back, so trusting the recorded hash flagged every
  // such skill as locally modified and pull silently skipped it forever.
  const withSidecar: LibrarySkill = {
    id: "skill-1",
    slug: "review-prs",
    currentVersionId: "v1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    files: { "SKILL.md": "# v1", ".paperclip-skill.json": "{\"stale\":true}" },
  };

  it("never materializes the sidecar as skill content", async () => {
    await pull(library(withSidecar));

    const sidecar = await readSidecar(path.join(teamDir, "review-prs"));
    expect(sidecar?.files).toEqual(["SKILL.md"]);
    expect(sidecar?.skillId).toBe("skill-1");
  });

  it("pulls an untouched directory whose sidecar hash was taken over the sidecar itself", async () => {
    const skillDir = path.join(teamDir, "review-prs");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# v1", "utf8");
    // Exactly what the old client wrote: a hash over the remote inventory with
    // the sidecar entry in it, against a file list that names the sidecar. The
    // sidecar is never read back, so that hash can never be reproduced.
    const poisonedHash = hashFileMap(new Map([
      ["SKILL.md", "# v1"],
      [".paperclip-skill.json", "{\"stale\":true}"],
    ]));
    await fs.writeFile(
      path.join(skillDir, ".paperclip-skill.json"),
      JSON.stringify({
        skillId: "skill-1",
        key: "paperclip/review-prs",
        remoteHash: poisonedHash,
        localHash: poisonedHash,
        syncedAt: "2026-08-01T00:00:00.000Z",
        currentVersionId: "v1",
        updatedAt: "2026-08-01T00:00:00.000Z",
        files: [".paperclip-skill.json", "SKILL.md"],
        lastChangedAt: "2026-08-01T00:00:00.000Z",
      }),
      "utf8",
    );

    // The server dropped the sidecar from its scan, so the snapshot no longer
    // carries it and the recorded hash stops matching anything.
    const rows = await pull(
      library({
        id: "skill-1",
        slug: "review-prs",
        currentVersionId: "v2",
        updatedAt: "2026-08-02T00:00:00.000Z",
        files: { "SKILL.md": "# v1" },
      }),
    );

    expect(statusOf(rows, "review-prs")).toBe("updated");
    expect((await readSidecar(skillDir))?.files).toEqual(["SKILL.md"]);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe("# v1");
  });

  it("still refuses to overwrite a genuinely edited file", async () => {
    await pull(library(withSidecar));
    await fs.writeFile(path.join(teamDir, "review-prs", "SKILL.md"), "# hand edited", "utf8");

    const rows = await pull(
      library({
        ...withSidecar,
        currentVersionId: "v2",
        updatedAt: "2026-08-02T00:00:00.000Z",
        files: { "SKILL.md": "# v2" },
      }),
    );

    expect(statusOf(rows, "review-prs")).toBe("skipped-local-modified");
  });
});

describe("file-level delete propagation", () => {
  const withReferences: LibrarySkill = {
    id: "skill-1",
    slug: "review-prs",
    currentVersionId: "v1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    files: { "SKILL.md": "# v1", "references/deep/notes.md": "# notes" },
  };

  it("removes files deleted upstream and prunes the directories they left empty", async () => {
    await pull(library(withReferences));
    expect(await fs.readFile(path.join(teamDir, "review-prs", "references/deep/notes.md"), "utf8")).toBe("# notes");

    const rows = await pull(
      library({
        ...withReferences,
        currentVersionId: "v2",
        updatedAt: "2026-08-02T00:00:00.000Z",
        files: { "SKILL.md": "# v2" },
      }),
    );

    expect(statusOf(rows, "review-prs")).toBe("updated");
    await expect(fs.stat(path.join(teamDir, "review-prs", "references"))).rejects.toThrow();
    const sidecar = await readSidecar(path.join(teamDir, "review-prs"));
    expect(sidecar?.files).toEqual(["SKILL.md"]);
  });

  it("treats a locally added file as drift and refuses to overwrite without --force", async () => {
    await pull(library(withReferences));
    await fs.writeFile(path.join(teamDir, "review-prs", "mine.md"), "# mine", "utf8");

    const next = library({
      ...withReferences,
      currentVersionId: "v2",
      updatedAt: "2026-08-02T00:00:00.000Z",
      files: { "SKILL.md": "# v2" },
    });
    const held = await pull(next);
    expect(statusOf(held, "review-prs")).toBe("skipped-local-modified");
    expect(await fs.readFile(path.join(teamDir, "review-prs", "SKILL.md"), "utf8")).toBe("# v1");

    const forced = await pull(next, { force: true });
    expect(statusOf(forced, "review-prs")).toBe("updated");
    expect(await fs.readFile(path.join(teamDir, "review-prs", "mine.md"), "utf8")).toBe("# mine");
  });

  it("treats an edited tracked file as drift", async () => {
    await pull(library(withReferences));
    await fs.writeFile(path.join(teamDir, "review-prs", "SKILL.md"), "# hand edited", "utf8");

    const rows = await pull(
      library({
        ...withReferences,
        currentVersionId: "v2",
        updatedAt: "2026-08-02T00:00:00.000Z",
        files: { "SKILL.md": "# v2", "references/deep/notes.md": "# notes" },
      }),
    );

    expect(statusOf(rows, "review-prs")).toBe("skipped-local-modified");
  });

  it("leaves no directory behind for a skill with no retrievable files", async () => {
    const rows = await pull(
      library({
        id: "skill-2",
        slug: "plugin-managed",
        currentVersionId: "v1",
        updatedAt: "2026-08-01T00:00:00.000Z",
        files: {},
      }),
    );

    expect(statusOf(rows, "plugin-managed")).toBe("skipped-no-files");
    await expect(fs.stat(path.join(teamDir, "plugin-managed"))).rejects.toThrow();
  });
});

describe("pruneTeamSkillDirs", () => {
  const base: LibrarySkill = {
    id: "skill-1",
    slug: "review-prs",
    currentVersionId: "v1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    files: { "SKILL.md": "# v1" },
  };

  it("only reports until apply is set, and never deletes a dirty or sidecar-less directory", async () => {
    await pull(library(base, { ...base, id: "skill-2", slug: "dropped" }));
    await pull(library(base, { ...base, id: "skill-3", slug: "edited" }));
    await fs.writeFile(path.join(teamDir, "edited", "SKILL.md"), "# hand edited", "utf8");
    await fs.mkdir(path.join(teamDir, "foreign"), { recursive: true });

    const keep = new Set(["review-prs"]);
    const reported = await pruneTeamSkillDirs(teamDir, keep, { apply: false });
    expect(reported.find((row) => row.name === "dropped")?.action).toBe("would-remove");
    expect(await fs.stat(path.join(teamDir, "dropped"))).toBeTruthy();

    const applied = await pruneTeamSkillDirs(teamDir, keep, { apply: true });
    expect(applied.find((row) => row.name === "dropped")?.action).toBe("removed");
    expect(applied.find((row) => row.name === "edited")).toMatchObject({ action: "kept" });
    expect(applied.find((row) => row.name === "foreign")).toMatchObject({ action: "kept" });
    await expect(fs.stat(path.join(teamDir, "dropped"))).rejects.toThrow();
    expect(await fs.stat(path.join(teamDir, "edited"))).toBeTruthy();
    expect(await fs.stat(path.join(teamDir, "foreign"))).toBeTruthy();
  });
});

describe("projectedTeamSkillNames", () => {
  it("counts every status that leaves a directory behind", () => {
    const rows = [
      { skill: { slug: "created" }, status: "created" },
      { skill: { slug: "updated" }, status: "updated" },
      { skill: { slug: "current" }, status: "up-to-date" },
      { skill: { slug: "planned" }, status: "dry-run" },
      { skill: { slug: "foreign" }, status: "skipped-foreign" },
      { skill: { slug: "edited" }, status: "skipped-local-modified" },
      { skill: { slug: "no-files" }, status: "skipped-no-files" },
    ] as unknown as SkillMaterializeRow[];

    expect(projectedTeamSkillNames(rows).sort()).toEqual([
      "created",
      "current",
      "edited",
      "foreign",
      "planned",
      "updated",
    ]);
  });
});

describe("skills pull lock", () => {
  it("reclaims a stale lock but yields to a live one", async () => {
    const lockPath = skillsPullLockPath();
    const held = await acquireSkillsPullLock(lockPath);
    expect(held).not.toBeNull();

    expect(await acquireSkillsPullLock(lockPath)).toBeNull();

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: "2020-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const reclaimed = await acquireSkillsPullLock(lockPath);
    expect(reclaimed).not.toBeNull();
    await reclaimed?.release();
    await held?.release();
  });

  it("makes runSkillsPull a silent no-op while another run holds the lock", async () => {
    const held = await acquireSkillsPullLock(skillsPullLockPath());
    const ctx = makeContext(library());

    const result = await runSkillsPull(ctx, {
      dir: [],
      adopt: false,
      pruneApply: false,
      dryRun: false,
      force: false,
    });

    expect(result).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
    await held?.release();
  });
});

describe("skills materialize seal", () => {
  function makeProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerSkillsCommands(program);
    return program;
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
  });

  async function runMaterialize(target: string): Promise<void> {
    await makeProgram().parseAsync(
      ["skills", "materialize", "--target", target, "--company-id", "company-1", "--api-base", "http://paperclip.test", "--api-key", "token"],
      { from: "user" },
    );
  }

  it("refuses a terminal skill directory", async () => {
    process.env.CLAUDE_HOME = path.join(root, "claude");
    await expect(runMaterialize(path.join(root, "claude", "skills"))).rejects.toThrow("exit:1");
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain("skills pull");
  });

  it("refuses a directory pull already manages", async () => {
    const managed = path.join(root, "custom-skills");
    await fs.mkdir(path.join(teamDir, "linked"), { recursive: true });
    await fs.mkdir(managed, { recursive: true });
    await fs.symlink(path.join(teamDir, "linked"), path.join(managed, "linked"));

    await expect(runMaterialize(managed)).rejects.toThrow("exit:1");
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain("skills pull");
  });
});
