import { SKILL_SIDECAR_FILENAME } from "@paperclipai/shared";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const SKILL_SIDECAR = SKILL_SIDECAR_FILENAME;

const IGNORED_SKILL_FILES: ReadonlySet<string> = new Set([SKILL_SIDECAR]);

// The sidecar is our own bookkeeping, so it counts as neither local content nor
// remote content. Callers on both sides of the comparison filter through here.
export function isIgnoredSkillFile(relativePath: string): boolean {
  return IGNORED_SKILL_FILES.has(relativePath);
}

// Collapses a snapshot-supplied path to a relative POSIX path that cannot escape
// the skill directory. Every writer normalizes through here so the server's
// stored inventory and the CLI's on-disk view key off identical strings.
export function normalizePortablePath(input: string): string {
  const parts: string[] = [];
  for (const segment of input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export function hashFileMap(files: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const filePath of [...files.keys()].sort()) {
    hash.update(filePath);
    hash.update("\0");
    hash.update(files.get(filePath) ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Reads every regular file under a skill directory keyed by POSIX-style relative
// path so on-disk state can be compared against the remote inventory as a whole.
// Symlinks are skipped: a skill directory only ever holds bytes we wrote.
export async function readSkillDirFiles(skillDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  await collectSkillDirFiles(skillDir, "", files);
  return files;
}

async function collectSkillDirFiles(
  root: string,
  relativeDir: string,
  files: Map<string, string>,
): Promise<void> {
  const entries = await fs
    .readdir(path.join(root, relativeDir), { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (isIgnoredSkillFile(relativePath)) continue;
    if (entry.isDirectory()) {
      await collectSkillDirFiles(root, relativePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await fs.readFile(path.join(root, relativePath), "utf8").catch(() => null);
    if (content !== null) files.set(relativePath, content);
  }
}

export async function hashSkillDir(skillDir: string): Promise<string> {
  return hashFileMap(await readSkillDirFiles(skillDir));
}

export function parentDirOf(relativePath: string): string {
  const idx = relativePath.lastIndexOf("/");
  return idx === -1 ? "" : relativePath.slice(0, idx);
}

export async function isDirectory(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}
