import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TeamDocProjection } from "../config.js";
import type {
  TeamDocFanoutSink,
  TeamRulesSnapshot,
  TeamWikiPageRef,
  TeamWikiPageSnapshot,
} from "./team-doc-fanout.js";

const execFileAsync = promisify(execFile);

const OV_TIMEOUT_MS = 60_000;

/**
 * Which rule sections OpenViking recalls on demand rather than injecting every
 * turn (MUL-515). Anything unrecognised counts as resident: over-injecting is
 * recoverable, a rule that silently never loads is not.
 *
 * Renderer pairing: `scripts/ov-sync/ov-sync.py` writes the same two URIs from
 * the same source rows during the MUL-559 step-6 observation window, so the
 * two renderers must be changed together or the file flaps between them.
 */
const ACTION_PREFIXES = ["第〇·五条", "二、", "三、", "四、", "八·五、", "九、"];

const RESIDENT_HEADER =
  "# Team Rules · 常驻组\n\n"
  + "> 每轮生效，SessionStart 全文注入，不走召回。用户提问里没有词能召回它们，召回不到等于静默失效（MUL-515）。\n\n";
const ACTION_HEADER =
  "# Team Rules · 动作组\n\n"
  + "> 挂在建卡 / 开分支 / 写卡 / 推状态 / 评审这些确定动作上，走 OV 按需召回（MUL-515）。\n\n";

/**
 * The `personal` space mirrors each terminal's own CLAUDE.md / AGENTS.md, which
 * that terminal already loads itself — recalling it from OpenViking would put
 * the same text into context twice. `scripts/ov-sync/ov-sync.py` skips it for
 * the same reason.
 */
const OV_SKIPPED_WIKI_SPACES = new Set(["personal"]);

export const RULES_RESIDENT_URI = "viking://resources/team/rules/resident/resident.md";
export const RULES_ACTION_URI = "viking://resources/team/rules/action/action.md";

export function renderRulesDocuments(snapshot: TeamRulesSnapshot): { resident: string; action: string } {
  const full = snapshot.notes.map((note) => note.body ?? "").join("\n\n");
  const head: string[] = [];
  const resident: string[] = [];
  const action: string[] = [];
  for (const part of full.split(/\n(?=## )/)) {
    const first = part.split("\n")[0] ?? "";
    if (!first.startsWith("## ")) {
      head.push(part);
      continue;
    }
    const tag = first.slice(3);
    (ACTION_PREFIXES.some((prefix) => tag.startsWith(prefix)) ? action : resident).push(part);
  }
  return {
    resident: RESIDENT_HEADER + head.join("\n") + "\n" + resident.join("\n"),
    action: ACTION_HEADER + action.join("\n"),
  };
}

export function wikiPageUri(page: TeamWikiPageRef): string {
  // Python's \w (unicode) minus the separators the URI keeps; everything else
  // becomes "_" so a title-derived path cannot smuggle a path segment.
  let safe = (page.path || page.pageId).replace(/[^\p{L}\p{N}_\-./]/gu, "_").replace(/^\/+|\/+$/g, "");
  if (!safe.endsWith(".md")) safe += ".md";
  return `viking://resources/team/wiki/${page.space}/${safe}`;
}

export function renderWikiPage(snapshot: TeamWikiPageSnapshot): string {
  return `# ${snapshot.title}\n\n`
    + `> source: paperclip team-wiki / ${snapshot.space} / ${snapshot.path}\n\n`
    + `${snapshot.body ?? ""}`;
}

async function runOv(bin: string, args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: OV_TIMEOUT_MS });
    return { code: 0, output: stderr || stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    // A missing binary or a timeout has no exit code to report; surface the
    // message so the retry log says which of the two happened.
    const output = e.stderr || e.stdout || e.message || "";
    return { code: typeof e.code === "number" ? e.code : 1, output };
  }
}

/**
 * `write --mode replace` reports NOT_FOUND for a file OpenViking has never
 * seen (unlike the MCP write, the CLI does not create on replace), so a first
 * publish falls through to `create`.
 */
async function ovWrite(bin: string, uri: string, text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ov-"));
  const file = path.join(dir, "payload.md");
  try {
    await fs.writeFile(file, text, "utf8");
    const replaced = await runOv(bin, ["write", uri, "--from-file", file, "--mode", "replace"]);
    if (replaced.code === 0) return "replaced";
    if (!replaced.output.includes("NOT_FOUND")) {
      throw new Error(`ov write --mode replace ${uri} failed: ${summarize(replaced.output)}`);
    }
    const created = await runOv(bin, ["write", uri, "--from-file", file, "--mode", "create"]);
    if (created.code !== 0) {
      throw new Error(`ov write --mode create ${uri} failed: ${summarize(created.output)}`);
    }
    return "created";
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * `ov rm` exits 0 for a URI OpenViking never had, reporting
 * `estimated_deleted_count: 0` — so the count, not the exit code, is what
 * separates "we removed it" from "there was nothing there", and neither is
 * swallowed: a non-zero exit throws, because a removal that did not happen
 * must not let the watermark move past the file it left behind.
 */
async function ovRemove(bin: string, uri: string): Promise<string> {
  const removed = await runOv(bin, ["rm", uri, "-o", "json"]);
  if (removed.code !== 0) throw new Error(`ov rm ${uri} failed: ${summarize(removed.output)}`);
  return /"estimated_deleted_count"\s*:\s*0\b/.test(removed.output) ? "absent" : "removed";
}

function summarize(output: string): string {
  return output.trim().replace(/\n/g, " ").slice(0, 200);
}

export const openVikingSink: TeamDocFanoutSink = {
  name: "openviking",
  async deliverRules(snapshot, projection) {
    const { resident, action } = renderRulesDocuments(snapshot);
    // Both files or neither: a half-written pair silently drops whichever
    // group failed, and the queue's retry is what makes "both" reachable.
    const residentStatus = await ovWrite(projection.ovBin, RULES_RESIDENT_URI, resident);
    const actionStatus = await ovWrite(projection.ovBin, RULES_ACTION_URI, action);
    return `resident=${residentStatus} action=${actionStatus}`;
  },
  async deliverWikiPage(snapshot, projection) {
    if (OV_SKIPPED_WIKI_SPACES.has(snapshot.space)) return `skipped-space=${snapshot.space}`;
    return await ovWrite(projection.ovBin, wikiPageUri(snapshot), renderWikiPage(snapshot));
  },
  /**
   * `ov mv` exists and would move the file in one call, but a rename also
   * rewrites the `> source:` line in the body, so it is never one call anyway —
   * and it fails NOT_FOUND on a source that is already gone, where `ov rm` is
   * idempotent. Write-then-remove reuses the push above and self-heals.
   */
  async retireWikiPage(previous, projection) {
    if (OV_SKIPPED_WIKI_SPACES.has(previous.space)) return `skipped-space=${previous.space}`;
    return await ovRemove(projection.ovBin, wikiPageUri(previous));
  },
};
