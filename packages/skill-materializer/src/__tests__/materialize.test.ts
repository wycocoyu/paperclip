import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_SIDECAR, readSkillDirFiles } from "../files.js";
import {
  EmptySkillSnapshotError,
  MissingRequiredSkillFileError,
  materializeSkill,
  type MaterializeSkillInput,
  type SkillSnapshotFile,
} from "../materialize.js";
import { readSidecar } from "../sidecar.js";

let root: string;
let skillDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-materializer-"));
  skillDir = path.join(root, "team-demo");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function snapshot(files: Record<string, string>): SkillSnapshotFile[] {
  return Object.entries(files).map(([filePath, content]) => ({ path: filePath, content }));
}

const BOOKKEEPING = { key: "company/demo", currentVersionId: "v1", updatedAt: "2026-01-01T00:00:00.000Z" };

async function pull(
  files: Record<string, string>,
  overrides: Partial<MaterializeSkillInput> = {},
) {
  return materializeSkill({
    skillId: "skill-1",
    targetDir: skillDir,
    files: snapshot(files),
    sidecar: BOOKKEEPING,
    ...overrides,
  });
}

async function listNames(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

describe("sidecar-managed directory", () => {
  it("creates the directory with the snapshot plus a sidecar", async () => {
    const result = await pull({ "SKILL.md": "one", "refs/a.md": "two" });

    expect(result.status).toBe("created");
    expect(result.files).toBe(2);
    expect(await readSkillDirFiles(skillDir)).toEqual(
      new Map([["SKILL.md", "one"], ["refs/a.md", "two"]]),
    );
    const sidecar = await readSidecar(skillDir);
    expect(sidecar?.skillId).toBe("skill-1");
    expect(sidecar?.files).toEqual(["SKILL.md", "refs/a.md"]);
  });

  it("reports up-to-date without rewriting when the bytes and markers hold still", async () => {
    await pull({ "SKILL.md": "one" });
    const before = await readSidecar(skillDir);

    const result = await pull({ "SKILL.md": "one" });

    expect(result.status).toBe("up-to-date");
    expect(await readSidecar(skillDir)).toEqual(before);
  });

  it("propagates an upstream delete and prunes the directory it emptied", async () => {
    await pull({ "SKILL.md": "one", "refs/a.md": "two" });

    const result = await pull({ "SKILL.md": "changed" });

    expect(result.status).toBe("updated");
    expect(result.removed).toEqual(["refs/a.md"]);
    expect(await listNames(skillDir)).toEqual([SKILL_SIDECAR, "SKILL.md"]);
  });

  it("keeps an untracked local file that the snapshot never claimed", async () => {
    await pull({ "SKILL.md": "one" });
    await fs.writeFile(path.join(skillDir, "notes.md"), "mine", "utf8");

    const result = await pull({ "SKILL.md": "two" }, { force: true });

    expect(result.status).toBe("updated");
    expect(await fs.readFile(path.join(skillDir, "notes.md"), "utf8")).toBe("mine");
  });
});

describe("conflict detection", () => {
  it("refuses a directory that carries no sidecar until --force", async () => {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "theirs", "utf8");

    const blocked = await pull({ "SKILL.md": "ours" });
    expect(blocked.status).toBe("skipped-foreign");
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe("theirs");

    const forced = await pull({ "SKILL.md": "ours" }, { force: true });
    expect(forced.status).toBe("updated");
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe("ours");
  });

  it("refuses to overwrite a locally edited file until --force", async () => {
    await pull({ "SKILL.md": "one" });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "edited by hand", "utf8");

    const blocked = await pull({ "SKILL.md": "two" });
    expect(blocked.status).toBe("skipped-local-modified");
    expect(blocked.note).toContain("local edits since last sync");
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe("edited by hand");

    const forced = await pull({ "SKILL.md": "two" }, { force: true });
    expect(forced.status).toBe("updated");
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe("two");
  });

  it("reads a locally added file as drift", async () => {
    await pull({ "SKILL.md": "one" });
    await fs.writeFile(path.join(skillDir, "extra.md"), "mine", "utf8");

    const result = await pull({ "SKILL.md": "two" });

    expect(result.status).toBe("skipped-local-modified");
    expect(result.note).toContain("local files added since last sync");
  });
});

describe("dryRun", () => {
  it("previews a create without touching the filesystem", async () => {
    const result = await pull({ "SKILL.md": "one" }, { dryRun: true });

    expect(result).toMatchObject({ status: "dry-run", files: 1, note: "would create" });
    expect(await fs.stat(skillDir).catch(() => null)).toBeNull();
  });

  it("previews an update without touching the filesystem", async () => {
    await pull({ "SKILL.md": "one" });
    const before = await readSkillDirFiles(skillDir);

    const result = await pull({ "SKILL.md": "two" }, { dryRun: true });

    expect(result).toMatchObject({ status: "dry-run", note: "would update" });
    expect(await readSkillDirFiles(skillDir)).toEqual(before);
  });
});

describe("server-owned directory (no sidecar)", () => {
  const versionSnapshot = { "SKILL.md": "v1 body", "refs/a.md": "aid" };

  it("writes the snapshot without a sidecar and skips a second identical run", async () => {
    const created = await pull(versionSnapshot, { sidecar: undefined });
    expect(created.status).toBe("created");
    expect(await listNames(skillDir)).toEqual(["SKILL.md", "refs"]);

    const again = await pull(versionSnapshot, { sidecar: undefined });
    expect(again.status).toBe("up-to-date");
  });

  it("clears a stale file the snapshot no longer carries", async () => {
    await pull(versionSnapshot, { sidecar: undefined });
    await fs.writeFile(path.join(skillDir, "stale.md"), "left over", "utf8");

    const result = await pull(versionSnapshot, { sidecar: undefined });

    expect(result.status).toBe("updated");
    expect(await listNames(skillDir)).toEqual(["SKILL.md", "refs"]);
  });

  it("fails before writing when the required file is absent", async () => {
    await expect(pull({ "refs/a.md": "aid" }, { sidecar: undefined, requireFile: "SKILL.md" }))
      .rejects.toBeInstanceOf(MissingRequiredSkillFileError);
    expect(await fs.stat(skillDir).catch(() => null)).toBeNull();
  });
});

describe("snapshot guards", () => {
  it("refuses an empty snapshot rather than emptying the directory", async () => {
    await pull({ "SKILL.md": "one" });

    await expect(pull({})).rejects.toBeInstanceOf(EmptySkillSnapshotError);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe("one");
  });

  it("never materializes a sidecar the snapshot claims to carry", async () => {
    const result = await pull({ "SKILL.md": "one", [SKILL_SIDECAR]: '{"skillId":"forged"}' });

    expect(result.files).toBe(1);
    expect((await readSidecar(skillDir))?.skillId).toBe("skill-1");
  });

  it("keeps a traversing snapshot path inside the skill directory", async () => {
    await pull({ "../escaped.md": "nope", "SKILL.md": "one" });

    expect(await fs.stat(path.join(root, "escaped.md")).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(skillDir, "escaped.md"), "utf8")).toBe("nope");
  });
});

describe("atomic swap", () => {
  // A file and a directory cannot share one name, so the second write throws
  // partway through — which is exactly the window the staging directory exists
  // to cover.
  const collidingSnapshot = { "a": "file", "a/b": "child" };

  it("leaves the previous content intact and no staging directory behind", async () => {
    await pull({ "SKILL.md": "one", "refs/a.md": "two" });
    const before = await readSkillDirFiles(skillDir);
    const sidecarBefore = await readSidecar(skillDir);

    await expect(pull(collidingSnapshot, { force: true })).rejects.toThrow(/EEXIST/);

    expect(await readSkillDirFiles(skillDir)).toEqual(before);
    expect(await readSidecar(skillDir)).toEqual(sidecarBefore);
    expect(await listNames(root)).toEqual(["team-demo"]);
  });

  it("leaves no directory at all when the very first write fails", async () => {
    await expect(pull(collidingSnapshot)).rejects.toThrow(/EEXIST/);

    expect(await listNames(root)).toEqual([]);
  });
});
