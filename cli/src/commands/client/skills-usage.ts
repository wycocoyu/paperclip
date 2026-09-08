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

const CACHE_VERSION = 2;

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
 * Streamed rather than slurped: ZCode replays the whole conversation into every
 * `model-io-*.jsonl` record, so one live session's rollout is 1.4 GB here.
 * `readFile` throws above the string cap, and a caught throw would report that
 * session as "no calls" — a silent undercount is worse than a slow read.
 */
async function parseFile(file: string): Promise<SkillCall[]> {
  const seen = new Set<string>();
  const calls: SkillCall[] = [];
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      // Cheap prefilter: the vast majority of transcript lines never mention
      // the tool, and JSON.parse is the whole cost of this command.
      if (!line.includes('"Skill"')) continue;
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
      // mtime is the window filter as well as the cache key: a session file is
      // touched on every append, so "last written inside the window" is the
      // closest cheap stand-in for "holds calls inside the window".
      if (!stat || stat.mtimeMs < since) continue;
      scanned[harness].files += 1;

      const cached = cache.files[file];
      let calls: SkillCall[];
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        calls = cached.calls;
      } else {
        try {
          calls = await parseFile(file);
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

export function printSkillsUsage(result: SkillsUsageResult): void {
  const nameWidth = Math.max(6, ...result.skills.map((row) => row.skill.length));
  console.log(
    ["skill".padEnd(nameWidth), "total".padStart(6), "claude".padStart(7), "codex".padStart(6), "zcode".padStart(6)].join(" "),
  );
  for (const row of result.skills) {
    console.log(
      [
        row.skill.padEnd(nameWidth),
        String(row.total).padStart(6),
        String(row.byHarness.claude).padStart(7),
        String(row.byHarness.codex).padStart(6),
        String(row.byHarness.zcode).padStart(6),
      ].join(" "),
    );
  }
  const files = Object.values(result.scanned).reduce((sum, entry) => sum + entry.files, 0);
  const parsed = Object.values(result.scanned).reduce((sum, entry) => sum + entry.parsed, 0);
  console.log(
    `${result.skills.length} skill(s), ${result.totalCalls} call(s) since ${result.since} — ${files} session file(s) in window, ${parsed} parsed (rest cached)`,
  );
  if (result.unreadable.length > 0) {
    console.log(`${result.unreadable.length} session file(s) unreadable; counts below the truth:`);
    for (const entry of result.unreadable) console.log(`  ${entry.file}: ${entry.error}`);
  }
}
