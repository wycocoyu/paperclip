import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listStoreFiles, resolveStorePath } from "./openspec.js";

// The store browser reads whatever the client names, so the containment guard
// is the only thing standing between it and the rest of the home directory.

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "openspec-store-test-"));
  root = path.join(base, "store");
  outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, "openspec", "specs", "工作流"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "# agents", "utf8");
  await fs.writeFile(path.join(root, "openspec", "config.yaml"), "id: ark", "utf8");
  await fs.writeFile(path.join(root, "openspec", "specs", "工作流", "spec.md"), "# 规格", "utf8");
  await fs.writeFile(path.join(root, "notes.txt"), "not readable", "utf8");
  await fs.writeFile(path.join(outside, "secret.md"), "secret", "utf8");
  await fs.symlink(path.join(outside, "secret.md"), path.join(root, "escape.md"));
  // A sibling whose name merely extends the root's would pass a string-prefix
  // containment check.
  await fs.mkdir(`${root}-evil`, { recursive: true });
  await fs.writeFile(path.join(`${root}-evil`, "sneak.md"), "sneak", "utf8");
});

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe("resolveStorePath containment", () => {
  it("resolves a file inside the store, including non-ASCII path segments", async () => {
    await expect(resolveStorePath(root, "AGENTS.md")).resolves.toBe(await fs.realpath(path.join(root, "AGENTS.md")));
    await expect(resolveStorePath(root, "openspec/specs/工作流/spec.md")).resolves.toBe(
      await fs.realpath(path.join(root, "openspec", "specs", "工作流", "spec.md")),
    );
  });

  it("rejects relative traversal out of the store", async () => {
    await expect(resolveStorePath(root, "../../etc/passwd")).resolves.toBeNull();
    await expect(resolveStorePath(root, "openspec/../../outside/secret.md")).resolves.toBeNull();
    await expect(resolveStorePath(root, "../store-evil/sneak.md")).resolves.toBeNull();
  });

  it("rejects absolute paths and null bytes", async () => {
    await expect(resolveStorePath(root, "/etc/passwd")).resolves.toBeNull();
    await expect(resolveStorePath(root, path.join(outside, "secret.md"))).resolves.toBeNull();
    await expect(resolveStorePath(root, "AGENTS.md\0.png")).resolves.toBeNull();
  });

  it("rejects a symlink that lands outside the store", async () => {
    await expect(resolveStorePath(root, "escape.md")).resolves.toBeNull();
  });

  it("rejects extensions outside the readable set, and directories", async () => {
    await expect(resolveStorePath(root, "notes.txt")).resolves.toBeNull();
    await expect(resolveStorePath(root, "openspec")).resolves.toBeNull();
    await expect(resolveStorePath(root, "")).resolves.toBeNull();
  });
});

describe("listStoreFiles", () => {
  it("lists readable files only, sorted, with store-relative paths", async () => {
    const files = await listStoreFiles(root);
    expect(files.map((file) => file.path)).toEqual([
      "AGENTS.md",
      "openspec/config.yaml",
      "openspec/specs/工作流/spec.md",
    ]);
  });

  it("skips .git so the listing stays the spec tree", async () => {
    await fs.mkdir(path.join(root, ".git", "objects"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "COMMIT_EDITMSG.md"), "msg", "utf8");
    const files = await listStoreFiles(root);
    expect(files.some((file) => file.path.startsWith(".git/"))).toBe(false);
    await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
  });
});
