import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  containsPullManagedLinks,
  cursorSkillsHome,
  ensureGitExcludeEntry,
  installSkillsForTarget,
  pruneTerminalSkillLinks,
  resolvePaperclipRepoRoot,
  terminalSkillTargets,
} from "../commands/client/skill-links.js";

let root: string;
let upstreamDir: string;
let teamDir: string;
let targetDir: string;

async function writeSkill(dir: string, name: string, body: string): Promise<string> {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf8");
  return skillDir;
}

function sources() {
  return [
    { dir: upstreamDir, label: "skills" },
    { dir: teamDir, label: "skills-team" },
  ];
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-links-"));
  upstreamDir = path.join(root, "skills");
  teamDir = path.join(root, "skills-team");
  targetDir = path.join(root, "terminal");
  await fs.mkdir(upstreamDir, { recursive: true });
  await fs.mkdir(teamDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("installSkillsForTarget link maintenance", () => {
  it("leaves a correct link untouched and rebuilds only the slugs that changed", async () => {
    await writeSkill(teamDir, "steady", "# steady");
    await writeSkill(teamDir, "moved", "# moved");

    await installSkillsForTarget(sources(), targetDir, "custom", { repoint: true });
    const before = {
      steady: (await fs.lstat(path.join(targetDir, "steady"))).ino,
      moved: (await fs.lstat(path.join(targetDir, "moved"))).ino,
    };

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", {
      repoint: true,
      rebuild: new Set(["moved"]),
    });

    expect(summary.linked).toEqual(["moved"]);
    expect(summary.skipped).toEqual(["steady"]);
    expect((await fs.lstat(path.join(targetDir, "steady"))).ino).toBe(before.steady);
    expect((await fs.lstat(path.join(targetDir, "moved"))).ino).not.toBe(before.moved);
  });

  it("repoints a link aimed elsewhere without touching what it pointed at", async () => {
    const foreignHome = path.join(root, "elsewhere");
    const foreignSkill = await writeSkill(foreignHome, "gatekeeper", "# from elsewhere");
    await writeSkill(teamDir, "gatekeeper", "# from the library");
    await fs.symlink(foreignSkill, path.join(targetDir, "gatekeeper"));

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", { repoint: true });

    expect(summary.repointed).toEqual([
      { name: "gatekeeper", from: foreignSkill, to: path.join(teamDir, "gatekeeper") },
    ]);
    expect(await fs.realpath(path.join(targetDir, "gatekeeper"))).toBe(
      await fs.realpath(path.join(teamDir, "gatekeeper")),
    );
    expect(await fs.readFile(path.join(foreignSkill, "SKILL.md"), "utf8")).toBe("# from elsewhere");
  });

  it("leaves a link aimed elsewhere alone when repointing is not requested", async () => {
    const foreignSkill = await writeSkill(path.join(root, "elsewhere"), "gatekeeper", "# from elsewhere");
    await writeSkill(teamDir, "gatekeeper", "# from the library");
    await fs.symlink(foreignSkill, path.join(targetDir, "gatekeeper"));

    const summary = await installSkillsForTarget(sources(), targetDir, "custom");

    expect(summary.repointed).toEqual([]);
    expect(summary.skipped).toEqual(["gatekeeper"]);
    expect(summary.conflicts[0]?.reason).toContain(foreignSkill);
    expect(await fs.realpath(path.join(targetDir, "gatekeeper"))).toBe(await fs.realpath(foreignSkill));
  });

  it("rebuilds a dangling link", async () => {
    await writeSkill(teamDir, "revived", "# revived");
    await fs.symlink(path.join(root, "gone"), path.join(targetDir, "revived"));

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", { repoint: true });

    expect(summary.linked).toEqual(["revived"]);
    expect(await fs.realpath(path.join(targetDir, "revived"))).toBe(
      await fs.realpath(path.join(teamDir, "revived")),
    );
  });

  it("reports a conflict and keeps a real directory when --adopt is absent", async () => {
    await writeSkill(teamDir, "agent-reach", "# canonical");
    await writeSkill(targetDir, "agent-reach", "# canonical");

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", { repoint: true });

    expect(summary.adopted).toEqual([]);
    expect(summary.conflicts[0]).toMatchObject({ name: "agent-reach" });
    expect((await fs.lstat(path.join(targetDir, "agent-reach"))).isDirectory()).toBe(true);
  });

  it("adopts a byte-identical directory and keeps a diverged one", async () => {
    await writeSkill(teamDir, "same", "# canonical");
    await writeSkill(targetDir, "same", "# canonical");
    await writeSkill(teamDir, "diverged", "# canonical");
    const localDiverged = await writeSkill(targetDir, "diverged", "# canonical");
    await fs.writeFile(path.join(localDiverged, "extra.md"), "# extra", "utf8");

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", {
      repoint: true,
      adopt: true,
    });

    expect(summary.adopted).toEqual(["same"]);
    expect((await fs.lstat(path.join(targetDir, "same"))).isSymbolicLink()).toBe(true);
    expect(summary.conflicts.map((row) => row.name)).toEqual(["diverged"]);
    expect((await fs.lstat(path.join(targetDir, "diverged"))).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(localDiverged, "extra.md"), "utf8")).toBe("# extra");
  });

  it("ignores the paperclip sidecar when comparing an adoption candidate", async () => {
    await writeSkill(teamDir, "same", "# canonical");
    await fs.writeFile(
      path.join(teamDir, "same", ".paperclip-skill.json"),
      JSON.stringify({ skillId: "s1", remoteHash: "a" }),
      "utf8",
    );
    await writeSkill(targetDir, "same", "# canonical");

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", {
      repoint: true,
      adopt: true,
    });

    expect(summary.adopted).toEqual(["same"]);
  });

  it("gives skills/ the slug when both sources carry it and reports the shadow", async () => {
    await writeSkill(upstreamDir, "paperclip", "# upstream");
    await writeSkill(teamDir, "paperclip", "# library copy");
    await writeSkill(teamDir, "library-only", "# library only");

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", { repoint: true });

    expect(await fs.realpath(path.join(targetDir, "paperclip"))).toBe(
      await fs.realpath(path.join(upstreamDir, "paperclip")),
    );
    expect(await fs.realpath(path.join(targetDir, "library-only"))).toBe(
      await fs.realpath(path.join(teamDir, "library-only")),
    );
    expect(summary.shadowed).toEqual([
      {
        name: "paperclip",
        winner: path.join(upstreamDir, "paperclip"),
        loser: path.join(teamDir, "paperclip"),
      },
    ]);
  });

  it("links nothing for a slug that never materialized a directory", async () => {
    await writeSkill(teamDir, "present", "# present");

    await installSkillsForTarget(sources(), targetDir, "custom", { repoint: true });

    expect(await fs.readdir(targetDir)).toEqual(["present"]);
  });

  it("keeps a user's own ~/.agents/skills link that this run does not manage", async () => {
    const agentsHome = path.join(root, "fake-home", ".agents", "skills");
    const crossTerminal = await writeSkill(agentsHome, "lark-doc", "# lark-doc");
    await fs.symlink(crossTerminal, path.join(targetDir, "lark-doc"));
    await writeSkill(teamDir, "review-prs", "# review-prs");

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", { repoint: true });

    expect(summary.removed).toEqual([]);
    expect(await fs.realpath(path.join(targetDir, "lark-doc"))).toBe(await fs.realpath(crossTerminal));
  });

  it("still sweeps unmanaged ~/.agents/skills links when the caller opts in", async () => {
    const agentsHome = path.join(root, "fake-home", ".agents", "skills");
    const crossTerminal = await writeSkill(agentsHome, "lark-doc", "# lark-doc");
    await fs.symlink(crossTerminal, path.join(targetDir, "lark-doc"));
    await writeSkill(teamDir, "review-prs", "# review-prs");

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", {
      sweepMaintainerOnly: true,
    });

    expect(summary.removed).toEqual(["lark-doc"]);
    expect(await fs.readdir(targetDir)).toEqual(["review-prs"]);
  });

  it("does not claim a repoint that failed to land", async () => {
    const foreignSkill = await writeSkill(path.join(root, "elsewhere"), "gatekeeper", "# elsewhere");
    await writeSkill(teamDir, "gatekeeper", "# library");
    await fs.symlink(foreignSkill, path.join(targetDir, "gatekeeper"));

    await fs.chmod(targetDir, 0o500);
    try {
      const summary = await installSkillsForTarget(sources(), targetDir, "custom", { repoint: true });

      expect(summary.repointed).toEqual([]);
      expect(summary.linked).toEqual([]);
      expect(summary.failed.map((row) => row.name)).toEqual(["gatekeeper"]);
    } finally {
      await fs.chmod(targetDir, 0o700);
    }
    expect(await fs.realpath(path.join(targetDir, "gatekeeper"))).toBe(await fs.realpath(foreignSkill));
  });

  it("keeps going and reports the slug when an adoption cannot be removed", async () => {
    await writeSkill(teamDir, "stuck", "# canonical");
    await writeSkill(targetDir, "stuck", "# canonical");

    await fs.chmod(targetDir, 0o500);
    try {
      const summary = await installSkillsForTarget(sources(), targetDir, "custom", {
        repoint: true,
        adopt: true,
      });

      expect(summary.adopted).toEqual([]);
      expect(summary.failed.map((row) => row.name)).toEqual(["stuck"]);
    } finally {
      await fs.chmod(targetDir, 0o700);
    }
    expect((await fs.lstat(path.join(targetDir, "stuck"))).isDirectory()).toBe(true);
  });

  it("previews team skills that the first materialize has not written yet", async () => {
    await fs.rm(teamDir, { recursive: true, force: true });
    await writeSkill(upstreamDir, "paperclip", "# upstream");
    const projected = [
      { dir: upstreamDir, label: "skills" },
      { dir: teamDir, label: "skills-team", projectedNames: ["agent-reach", "human-writing", "paperclip"] },
    ];

    const summary = await installSkillsForTarget(projected, targetDir, "custom", {
      repoint: true,
      dryRun: true,
    });

    expect(summary.linked.sort()).toEqual(["agent-reach", "human-writing", "paperclip"]);
    expect(summary.shadowed.map((row) => row.name)).toEqual(["paperclip"]);
    expect(await fs.readdir(targetDir)).toEqual([]);
  });

  it("refuses to promise an adoption it cannot verify before the first materialize", async () => {
    await fs.rm(teamDir, { recursive: true, force: true });
    await writeSkill(targetDir, "agent-reach", "# a real local directory");
    const projected = [
      { dir: upstreamDir, label: "skills" },
      { dir: teamDir, label: "skills-team", projectedNames: ["agent-reach"] },
    ];

    const summary = await installSkillsForTarget(projected, targetDir, "custom", {
      repoint: true,
      adopt: true,
      dryRun: true,
    });

    expect(summary.adopted).toEqual([]);
    expect(summary.linked).toEqual([]);
    expect(summary.conflicts).toEqual([
      {
        name: "agent-reach",
        reason: "cannot preview adoption before the first materialize; rerun after a real pull",
      },
    ]);
    expect((await fs.lstat(path.join(targetDir, "agent-reach"))).isDirectory()).toBe(true);
  });

  it("writes nothing under --dry-run", async () => {
    await writeSkill(teamDir, "planned", "# planned");

    const summary = await installSkillsForTarget(sources(), targetDir, "custom", {
      repoint: true,
      dryRun: true,
    });

    expect(summary.linked).toEqual(["planned"]);
    expect(await fs.readdir(targetDir)).toEqual([]);
  });
});

describe("pruneTerminalSkillLinks", () => {
  beforeEach(async () => {
    await writeSkill(teamDir, "live", "# live");
    await writeSkill(path.join(root, "elsewhere"), "foreign", "# foreign");
    await fs.mkdir(path.join(targetDir, "hand-written"), { recursive: true });
    await fs.symlink(path.join(root, "elsewhere", "foreign"), path.join(targetDir, "foreign"));
    await fs.symlink(path.join(root, "elsewhere", "gone"), path.join(targetDir, "foreign-dead"));
    await fs.symlink(path.join(teamDir, "live"), path.join(targetDir, "live"));
    await fs.symlink(path.join(teamDir, "gone"), path.join(targetDir, "dead"));
  });

  it("removes only dead links into the managed root", async () => {
    const rows = await pruneTerminalSkillLinks(targetDir, teamDir, { apply: true });

    expect(rows.map((row) => row.name)).toEqual(["dead"]);
    expect((await fs.readdir(targetDir)).sort()).toEqual([
      "foreign",
      "foreign-dead",
      "hand-written",
      "live",
    ]);
  });

  it("only reports when apply is false", async () => {
    const rows = await pruneTerminalSkillLinks(targetDir, teamDir, { apply: false });

    expect(rows).toEqual([
      {
        target: targetDir,
        name: "dead",
        linkedTo: path.join(teamDir, "gone"),
        action: "would-remove",
      },
    ]);
    expect((await fs.readdir(targetDir)).sort()).toContain("dead");
  });
});

/**
 * Cursor reads two sets of links out of one directory: the plain slugs
 * `skills pull` plants here, and `<slug>--<hash>` links the server's agent
 * skill sync points at the managed source. Adding Cursor as a pull target has
 * to leave the second set alone — it belongs to the other mechanism, and
 * clearing it would silently unequip the agent.
 */
describe("cursor as a pull target", () => {
  it("is one of the terminal targets, under ~/.cursor/skills", () => {
    const cursor = terminalSkillTargets().find((entry) => entry.tool === "cursor");
    expect(cursor?.dir).toBe(path.join(os.homedir(), ".cursor", "skills"));
    expect(cursor?.dir).toBe(cursorSkillsHome());
  });

  it("honours CURSOR_HOME, which names the .cursor directory itself", () => {
    const previous = process.env.CURSOR_HOME;
    process.env.CURSOR_HOME = "/tmp/some-cursor";
    try {
      expect(cursorSkillsHome()).toBe(path.join("/tmp/some-cursor", "skills"));
    } finally {
      if (previous === undefined) delete process.env.CURSOR_HOME;
      else process.env.CURSOR_HOME = previous;
    }
  });

  it("plants the team slugs beside the server's managed-source links without disturbing them", async () => {
    await writeSkill(teamDir, "team-grilling", "# grilling");
    const managedRoot = path.join(root, "managed");
    await writeSkill(managedRoot, "team-grilling", "# managed copy");
    const managedLink = path.join(targetDir, "team-grilling--53750d66a4");
    await fs.symlink(path.join(managedRoot, "team-grilling"), managedLink);

    const summary = await installSkillsForTarget(sources(), targetDir, "cursor", { repoint: true });

    expect(summary.tool).toBe("cursor");
    expect(summary.linked).toEqual(["team-grilling"]);
    expect((await fs.readdir(targetDir)).sort()).toEqual(["team-grilling", "team-grilling--53750d66a4"]);
    expect(await fs.readlink(managedLink)).toBe(path.join(managedRoot, "team-grilling"));
    expect(await fs.readlink(path.join(targetDir, "team-grilling"))).toBe(path.join(teamDir, "team-grilling"));
  });

  it("never prunes a managed-source link, even a dead one", async () => {
    const managedRoot = path.join(root, "managed");
    await fs.mkdir(managedRoot, { recursive: true });
    const managedLink = path.join(targetDir, "team-grilling--53750d66a4");
    await fs.symlink(path.join(managedRoot, "team-grilling"), managedLink);

    // Pruning is scoped to links into skills-team; the managed source is a
    // different root, so a dangling link there is not ours to clean up.
    const rows = await pruneTerminalSkillLinks(targetDir, teamDir, { apply: true });

    expect(rows).toEqual([]);
    expect(await fs.readdir(targetDir)).toEqual(["team-grilling--53750d66a4"]);
  });
});

describe("repo and git helpers", () => {
  it("finds the checkout that holds both pnpm-workspace.yaml and skills/", async () => {
    await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    const nested = path.join(root, "cli", "dist");
    await fs.mkdir(nested, { recursive: true });

    expect(await resolvePaperclipRepoRoot([nested])).toBe(root);
    expect(await resolvePaperclipRepoRoot([path.join(os.tmpdir(), "no-such-dir-xyz")])).toBeNull();
  });

  it("appends the exclude entry once and finds the common dir from a worktree pointer", async () => {
    const commonGitDir = path.join(root, "main", ".git");
    await fs.mkdir(path.join(commonGitDir, "info"), { recursive: true });
    await fs.writeFile(path.join(commonGitDir, "info", "exclude"), "# existing", "utf8");
    await fs.writeFile(
      path.join(root, ".git"),
      `gitdir: ${path.join(commonGitDir, "worktrees", "wt")}\n`,
      "utf8",
    );

    expect(await ensureGitExcludeEntry(root, "skills-team/")).toBe("added");
    expect(await ensureGitExcludeEntry(root, "skills-team/")).toBe("present");
    expect(await fs.readFile(path.join(commonGitDir, "info", "exclude"), "utf8")).toBe(
      "# existing\nskills-team/\n",
    );
  });

  it("detects a directory already managed by pull", async () => {
    await writeSkill(teamDir, "managed", "# managed");
    expect(await containsPullManagedLinks(targetDir)).toBe(false);
    await fs.symlink(path.join(teamDir, "managed"), path.join(targetDir, "managed"));
    expect(await containsPullManagedLinks(targetDir)).toBe(true);
  });
});
