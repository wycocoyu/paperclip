import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDirectory } from "./files.js";

/**
 * Where each terminal looks for skills, and how to tell whether a slug is
 * actually projected there. Both the CLI (`skills pull`, `skills status`) and
 * the server's read-only status route answer from these, so they live beside
 * the materializer rather than inside either caller.
 */
export type TerminalSkillTool = "codex" | "claude" | "kimi" | "zcode" | "cursor" | "custom";

// Team skills materialize into the repo checkout beside the upstream `skills/`
// tree so both link sources live under one root and stay out of the worktree.
export const TEAM_SKILLS_DIRNAME = "skills-team";

export function codexSkillsHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".codex");
  return path.join(base, "skills");
}

export function claudeSkillsHome(): string {
  const fromEnv = process.env.CLAUDE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".claude");
  return path.join(base, "skills");
}

export function kimiSkillsHome(): string {
  const fromEnv = process.env.KIMI_CODE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".kimi-code");
  return path.join(base, "skills");
}

// ZCode discovers skills in ~/.agents/skills (the cross-tool shared dir) in
// addition to its own ~/.zcode/skills — installing into the shared dir keeps
// one link serving ZCode today and any other tool that adopts the convention.
export function zcodeSkillsHome(): string {
  const fromEnv = process.env.ZCODE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".agents");
  return path.join(base, "skills");
}

// `CURSOR_HOME` names the `.cursor` directory itself, the same way the repo's
// cursor-local adapter reads it, so the skills home hangs off it unchanged.
//
// Cursor also carries a second, server-driven set of links here, named
// `<slug>--<hash>` and pointing at the agent's managed source
// (`server/src/services/company-skills.ts` buildSkillRuntimeName). Those are
// not this function's business: `skills pull` only ever touches slugs its own
// sources claim, so the two sets coexist in one directory.
export function cursorSkillsHome(): string {
  const fromEnv = process.env.CURSOR_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".cursor");
  return path.join(base, "skills");
}

export function terminalSkillTargets(): Array<{ tool: TerminalSkillTool; dir: string }> {
  return [
    { tool: "codex", dir: codexSkillsHome() },
    { tool: "claude", dir: claudeSkillsHome() },
    { tool: "kimi", dir: kimiSkillsHome() },
    { tool: "zcode", dir: zcodeSkillsHome() },
    { tool: "cursor", dir: cursorSkillsHome() },
  ];
}

// The repo checkout is the canonical home for both link sources. Resolution
// starts from the caller's module because `skills pull` is also fired by editor
// hooks from whatever directory the user happens to sit in.
export async function resolvePaperclipRepoRoot(startDirs: string[]): Promise<string | null> {
  for (const start of startDirs) {
    let dir = path.resolve(start);
    while (true) {
      const marked = await fs
        .stat(path.join(dir, "pnpm-workspace.yaml"))
        .then((stats) => stats.isFile())
        .catch(() => false);
      if (marked && (await isDirectory(path.join(dir, "skills")))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export interface SkillLinkInspection {
  state: "absent" | "correct" | "dangling" | "elsewhere" | "occupied";
  linkedTo?: string;
}

// The authoritative source for a slug is whichever configured source claims it
// first, so correctness is "points at that exact path" — never "points anywhere
// under a source root".
export async function inspectSkillLink(target: string, source: string): Promise<SkillLinkInspection> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) return { state: "absent" };
  if (!existing.isSymbolicLink()) return { state: "occupied" };

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return { state: "dangling" };
  const resolved = path.resolve(
    path.isAbsolute(linkedPath) ? linkedPath : path.resolve(path.dirname(target), linkedPath),
  );
  const linkedTargetExists = await fs
    .stat(resolved)
    .then(() => true)
    .catch(() => false);
  if (!linkedTargetExists) return { state: "dangling", linkedTo: resolved };
  if (resolved === path.resolve(source)) return { state: "correct", linkedTo: resolved };
  return { state: "elsewhere", linkedTo: resolved };
}
