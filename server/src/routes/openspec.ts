import { Router } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

/**
 * OpenSpec store browser: a read-only window onto the team's openspec git
 * checkout. The files on disk are the single source of truth — nothing is
 * copied, cached or mirrored into the database, so every request reads the
 * working tree as it stands and a `git pull` shows up immediately.
 */

/** The checkout lives at a fixed location; a configurable path needs an owner
 *  decision this read-only view does not yet have. */
export const OPENSPEC_STORE_ROOT = path.resolve(os.homedir(), "dev", "openspec-store");

/** Only text formats openspec actually stores; anything else stays unreadable
 *  so this never turns into a general file server for the home directory. */
const READABLE_EXTENSIONS = new Set([".md", ".yaml", ".yml"]);

/** Walking `.git` would swamp the listing with thousands of objects. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** A single file is small; the cap stops a stray huge file from being read
 *  into memory whole. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type OpenSpecFile = { path: string; size: number; modifiedAt: string };

/**
 * Resolve a client-supplied relative path against the store root, refusing
 * anything that lands outside it.
 *
 * Both sides are canonicalized through `realpath` before comparison, so a
 * symlink inside the store pointing at `/etc` is rejected on where it *lands*,
 * not on how it is spelled. Containment is tested segment-wise via
 * `path.relative` rather than by string prefix, so a sibling directory whose
 * name merely starts with the root's cannot pass. That one test also covers
 * absolute paths (they resolve outside the root) and null bytes (`realpath`
 * throws), so neither needs an early guard of its own.
 *
 * @returns the canonical absolute path, or null when the request escapes the
 *   root, names something that is not a readable file, or does not exist.
 */
export async function resolveStorePath(root: string, requested: unknown): Promise<string | null> {
  if (typeof requested !== "string" || requested.trim().length === 0) return null;
  if (!READABLE_EXTENSIONS.has(path.extname(requested).toLowerCase())) return null;

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(root);
  } catch {
    return null;
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = await fs.realpath(path.resolve(canonicalRoot, requested));
  } catch {
    return null;
  }

  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const stats = await fs.stat(canonicalTarget).catch(() => null);
  if (!stats?.isFile()) return null;
  return canonicalTarget;
}

/**
 * Every readable file under the root, as store-relative POSIX paths.
 *
 * Directory entries are read with `withFileTypes`, and symlinks are skipped
 * rather than followed: a link out of the store would otherwise put paths in
 * the listing that {@link resolveStorePath} then refuses to open.
 */
export async function listStoreFiles(root: string): Promise<OpenSpecFile[]> {
  const files: OpenSpecFile[] = [];

  async function walk(dir: string, prefix: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!READABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stats = await fs.stat(path.join(dir, entry.name)).catch(() => null);
      if (!stats) continue;
      files.push({ path: relative, size: stats.size, modifiedAt: stats.mtime.toISOString() });
    }
  }

  await walk(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * The change a card belongs to, found by reading the store rather than by
 * anyone registering the pair. A change already names its card — in its
 * directory name, its proposal, or its tasks — so a second copy of that
 * relationship in the database would just be one more thing to keep in sync,
 * and it would go stale the moment a change is archived and renamed.
 *
 * Only `changes/` is searched. `specs/` holds the accumulated spec, which
 * outlives any one card and is not what "which change was this card" means.
 */
export type OpenSpecChangeMatch = {
  /** Store-relative path of the change directory. */
  path: string;
  /** Directory name with the archive date prefix stripped. */
  name: string;
  archived: boolean;
  /** Which files inside named the card — evidence for the caller to judge. */
  matchedIn: string[];
};

/** `MUL-563` must not match `MUL-5631`, so the digits are bounded on both ends. */
function issueMentionPattern(identifier: string): RegExp {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}([^0-9]|$)`, "i");
}

export async function findChangesForIssue(
  root: string,
  identifier: string,
  files: OpenSpecFile[],
): Promise<OpenSpecChangeMatch[]> {
  const pattern = issueMentionPattern(identifier);
  // Group the listing by the change directory each file sits in. A change is
  // the path segment right under `changes/`, or under `changes/archive/`.
  const byChange = new Map<string, string[]>();
  for (const file of files) {
    const m = /^(.*changes\/(?:archive\/)?[^/]+)\//.exec(file.path);
    if (!m) continue;
    const dir = m[1]!;
    const bucket = byChange.get(dir);
    if (bucket) bucket.push(file.path);
    else byChange.set(dir, [file.path]);
  }

  const matches: OpenSpecChangeMatch[] = [];
  for (const [dir, dirFiles] of byChange) {
    const matchedIn: string[] = [];
    // The directory name counts as a mention on its own: an archived change is
    // renamed to `<date>-<card>-<slug>`, which is often the only place the card
    // number survives.
    if (pattern.test(dir.split("/").pop() ?? "")) matchedIn.push("(目录名)");
    for (const filePath of dirFiles) {
      const stats = await fs.stat(path.join(root, filePath)).catch(() => null);
      if (!stats || stats.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(path.join(root, filePath), "utf8").catch(() => null);
      if (content && pattern.test(content)) matchedIn.push(filePath);
    }
    if (matchedIn.length === 0) continue;
    const name = (dir.split("/").pop() ?? dir).replace(/^\d{4}-\d{2}-\d{2}-/, "");
    matches.push({ path: dir, name, archived: dir.includes("/archive/"), matchedIn });
  }
  matches.sort((a, b) => Number(a.archived) - Number(b.archived) || a.path.localeCompare(b.path));
  return matches;
}

export function openspecRoutes() {
  const router = Router();

  /**
   * A missing checkout is a normal state on a machine that never cloned the
   * store, so it answers `available: false` with an empty listing instead of
   * failing the page.
   */
  router.get("/companies/:companyId/openspec/files", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    const rootStats = await fs.stat(OPENSPEC_STORE_ROOT).catch(() => null);
    if (!rootStats?.isDirectory()) {
      res.json({ root: OPENSPEC_STORE_ROOT, available: false, files: [] });
      return;
    }
    res.json({
      root: OPENSPEC_STORE_ROOT,
      available: true,
      files: await listStoreFiles(OPENSPEC_STORE_ROOT),
    });
  });

  /**
   * Which changes mention this card. Read at close-out to catch a card whose
   * openspec work was never linked back — the answer is derived from the store
   * every time, so a renamed or archived change still resolves.
   */
  router.get("/companies/:companyId/openspec/changes-for-issue", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    const identifier = typeof req.query.identifier === "string" ? req.query.identifier.trim() : "";
    if (!identifier) throw badRequest("identifier query parameter is required");
    const rootStats = await fs.stat(OPENSPEC_STORE_ROOT).catch(() => null);
    if (!rootStats?.isDirectory()) {
      res.json({ root: OPENSPEC_STORE_ROOT, available: false, changes: [] });
      return;
    }
    const files = await listStoreFiles(OPENSPEC_STORE_ROOT);
    res.json({
      root: OPENSPEC_STORE_ROOT,
      available: true,
      changes: await findChangesForIssue(OPENSPEC_STORE_ROOT, identifier, files),
    });
  });

  router.get("/companies/:companyId/openspec/file", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    const requested = req.query.path;
    if (typeof requested !== "string") throw badRequest("path is required");
    const resolved = await resolveStorePath(OPENSPEC_STORE_ROOT, requested);
    if (!resolved) throw notFound("File not found");
    const stats = await fs.stat(resolved);
    if (stats.size > MAX_FILE_BYTES) throw badRequest("File is too large to display");
    res.json({ path: requested, content: await fs.readFile(resolved, "utf8"), modifiedAt: stats.mtime.toISOString() });
  });

  return router;
}
