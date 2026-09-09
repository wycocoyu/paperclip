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
