import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/**
 * Counting rule, frozen on MUL-553 and re-stated here because it decides the
 * parser rather than merely describing it:
 *
 * - only explicit Skill tool calls count; reading a SKILL.md through Read/exec
 *   does not, and neither does appearing in the harness's skill listing
 * - sub-agent calls count (they are real consumption)
 * - this machine only, no cross-device aggregation
 * - N calls of one skill inside one session count N times
 *
 * Calls are de-duplicated by tool-call id, which is what makes the last rule
 * survive a transcript format that replays history: ZCode's `model-io-*.jsonl`
 * records the full conversation on every request, so one call appears in every
 * later record. Counting lines instead of ids inflated a 7-call sample to 824.
 *
 * MUL-581 carves out Codex, which has no Skill tool at all: it consumes a skill
 * by reading `<dir>/SKILL.md`, so the rule above scored it a flat zero for every
 * skill and that zero was read as "nobody uses skills there". Codex therefore
 * counts reads instead — but *de-duplicated per session*, one read or twenty of
 * the same SKILL.md scoring 1. Raw reads run one to two orders of magnitude
 * above Claude's call counts (`ark-work-report` alone: 1394 across 12 files),
 * which would make the two columns and their sum meaningless side by side. The
 * two calibres differ and the UI says so; only the magnitudes are comparable.
 */
export type UsageHarness = "claude" | "codex" | "zcode";

export interface SkillUsageRow {
  skill: string;
  total: number;
  byHarness: Record<UsageHarness, number>;
}

export interface SkillsUsageResult {
  days: number;
  since: string;
  scanned: Record<UsageHarness, { files: number; parsed: number }>;
  totalCalls: number;
  /** Session files the scan could not read; their calls are missing from the totals. */
  unreadable: Array<{ file: string; error: string }>;
  skills: SkillUsageRow[];
}

interface SkillCall {
  id: string;
  skill: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  calls: SkillCall[];
}

interface UsageCache {
  version: number;
  files: Record<string, CacheEntry>;
}

// 3: Codex entries gained SKILL.md reads (MUL-581); a v2 entry for a Codex
// transcript holds an empty call list that is now wrong, and mtime+size cannot
// tell the two apart.
const CACHE_VERSION = 3;

export function usageCachePath(): string {
  return path.join(os.homedir(), ".paperclip", "skills-usage-cache.json");
}

/**
 * Claude keeps one append-only transcript per session, plus one per sub-agent
 * under `<session>/subagents/`. The recursive glob is what makes sub-agent
 * calls count; a `projects/*` + `*.jsonl` pair silently drops 467 of them.
 */
export function harnessSources(): Record<UsageHarness, string[]> {
  const home = os.homedir();
  return {
    claude: [path.join(home, ".claude", "projects")],
    codex: [path.join(home, ".codex", "sessions")],
    // `~/.agents` holds ZCode's *skill links*, not its transcripts; the
    // transcripts are the CLI's own rollout and sub-agent logs.
    zcode: [path.join(home, ".zcode", "cli", "rollout"), path.join(home, ".zcode", "cli", "agents")],
  };
}

async function collectJsonl(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

/**
 * Every harness writes a different envelope around the same `{name: "Skill",
 * input: {skill}}` block, and ZCode nests it two ways in one file. Walking the
 * record for that shape is what keeps one parser serving all three.
 */
export function extractSkillCalls(record: unknown): SkillCall[] {
  const calls: SkillCall[] = [];
  const stack: unknown[] = [record];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    if (obj.name === "Skill" && obj.input && typeof obj.input === "object") {
      const skill = (obj.input as Record<string, unknown>).skill;
      const id = obj.id;
      if (typeof skill === "string" && skill.length > 0) {
        calls.push({ skill, id: typeof id === "string" ? id : `${skill}:${calls.length}` });
      }
    }
    stack.push(...Object.values(obj));
  }
  return calls;
}

/**
 * Codex's exec records carry its own parse of the command it ran; a `sed`/`cat`
 * of a skill body shows up as `{type: "read", name: "SKILL.md", path}`. That
 * parsed form is the whole signal — grepping the raw path would also count the
 * SKILL.md mentions in Codex's own system prompt and in unrelated tool output.
 *
 * The slug is the directory holding the file, which covers every root in play
 * (`~/.codex/skills/x`, `~/.agents/skills/x`, `.system/x`, a plugin cache, a
 * relative `skills/x`) without a list of roots to keep current.
 */
export function extractCodexSkillReads(record: unknown): string[] {
  const skills: string[] = [];
  const stack: unknown[] = [record];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    if (obj.name === "SKILL.md" && obj.type === "read" && typeof obj.path === "string") {
      const slug = /(?:^|[/\\])([^/\\]+)[/\\]SKILL\.md$/.exec(obj.path)?.[1];
      if (slug) skills.push(slug);
    }
    stack.push(...Object.values(obj));
  }
  return skills;
}

/**
 * Streamed rather than slurped: ZCode replays the whole conversation into every
 * `model-io-*.jsonl` record, so one live session's rollout is 1.4 GB here.
 * `readFile` throws above the string cap, and a caught throw would report that
 * session as "no calls" — a silent undercount is worse than a slow read.
 */
async function parseFile(file: string, harness: UsageHarness): Promise<SkillCall[]> {
  const seen = new Set<string>();
  const calls: SkillCall[] = [];
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const codex = harness === "codex";
  try {
    for await (const line of lines) {
      // Cheap prefilter: the vast majority of transcript lines never mention
      // the tool, and JSON.parse is the whole cost of this command.
      const skillCall = line.includes('"Skill"');
      const skillRead = codex && line.includes('"SKILL.md"');
      if (!skillCall && !skillRead) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      for (const call of extractSkillCalls(record)) {
        if (seen.has(call.id)) continue;
        seen.add(call.id);
        calls.push(call);
      }
      if (!skillRead) continue;
      for (const skill of extractCodexSkillReads(record)) {
        // The id *is* the skill name, so the de-dup above collapses every
        // re-read inside this session to one — the whole session-scoped rule.
        const id = `read:${skill}`;
        if (seen.has(id)) continue;
        seen.add(id);
        calls.push({ id, skill });
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return calls;
}
async function readCache(): Promise<UsageCache> {
  try {
    const parsed = JSON.parse(await fs.readFile(usageCachePath(), "utf8")) as UsageCache;
    if (parsed?.version === CACHE_VERSION && parsed.files) return parsed;
  } catch {
    /* a missing or stale-format cache just means a full scan */
  }
  return { version: CACHE_VERSION, files: {} };
}

async function writeCache(cache: UsageCache): Promise<void> {
  const target = usageCachePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temp, JSON.stringify(cache), "utf8");
  await fs.rename(temp, target).catch(async (err) => {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  });
}

export interface SkillsUsageOptions {
  days: number;
  cache: boolean;
  /** Injectable clock so the window is testable. */
  now?: () => number;
}

export async function collectSkillsUsage(opts: SkillsUsageOptions): Promise<SkillsUsageResult> {
  const now = opts.now ? opts.now() : Date.now();
  const since = now - opts.days * 86_400_000;
  const cache = opts.cache ? await readCache() : { version: CACHE_VERSION, files: {} };
  const nextCache: UsageCache = { version: CACHE_VERSION, files: {} };

  const totals = new Map<string, SkillUsageRow>();
  const scanned = {
    claude: { files: 0, parsed: 0 },
    codex: { files: 0, parsed: 0 },
    zcode: { files: 0, parsed: 0 },
  } satisfies Record<UsageHarness, { files: number; parsed: number }>;
  let totalCalls = 0;
  const unreadable: Array<{ file: string; error: string }> = [];

  for (const [harness, dirs] of Object.entries(harnessSources()) as Array<[UsageHarness, string[]]>) {
    const files: string[] = [];
    for (const dir of dirs) await collectJsonl(dir, files);

    for (const file of files) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      const cached = cache.files[file];
      const fresh =
        cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
          ? cached
          : null;

      // mtime is the window filter as well as the cache key: a session file is
      // touched on every append, so "last written inside the window" is the
      // closest cheap stand-in for "holds calls inside the window".
      if (stat.mtimeMs < since) {
        // Outside *this* window but possibly inside another caller's. Carrying
        // the entry forward is what lets two windows share one cache file: drop
        // it and a 7-day scan evicts everything a 30-day scan paid 22s for, so
        // the two take turns re-parsing the archive.
        if (fresh) nextCache.files[file] = fresh;
        continue;
      }
      scanned[harness].files += 1;

      let calls: SkillCall[];
      if (fresh) {
        calls = fresh.calls;
      } else {
        try {
          calls = await parseFile(file, harness);
        } catch (err) {
          // Counted, not swallowed: an unread file is an unknown, and the
          // summary says how many so a wrong total is never silent.
          unreadable.push({ file, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        scanned[harness].parsed += 1;
      }
      nextCache.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, calls };

      for (const call of calls) {
        let row = totals.get(call.skill);
        if (!row) {
          row = { skill: call.skill, total: 0, byHarness: { claude: 0, codex: 0, zcode: 0 } };
          totals.set(call.skill, row);
        }
        row.total += 1;
        row.byHarness[harness] += 1;
        totalCalls += 1;
      }
    }
  }

  if (opts.cache) await writeCache(nextCache);

  return {
    days: opts.days,
    since: new Date(since).toISOString(),
    scanned,
    totalCalls,
    unreadable,
    skills: [...totals.values()].sort((a, b) => b.total - a.total || a.skill.localeCompare(b.skill)),
  };
}
