import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import pc from "picocolors";
import type { Command } from "commander";
import { getStoredBoardCredential, loginBoardCli } from "../../client/board-auth.js";
import { buildCliCommandLabel } from "../../client/command-label.js";
import { readConfig } from "../../config/store.js";
import { readContext, resolveProfile, type ClientContextProfile } from "../../client/context.js";
import { ApiRequestError, PaperclipApiClient } from "../../client/http.js";
import { missingDecisionBodySections, type DecisionLogEntry } from "@paperclipai/shared";
// decision-log 的切分与「已定」判定住在 shared：服务端收卡门禁与 document:put
// 校验读同一份判据，此处只转出去，不再留副本。
export { isSettledDecisionLogEntry, parseDecisionLogEntries, type DecisionLogEntry } from "@paperclipai/shared";
import { sessionIdFromEnv, sessionLocatorForSlug } from "@paperclipai/shared/session-locator";

export interface BaseClientOptions {
  config?: string;
  dataDir?: string;
  context?: string;
  profile?: string;
  apiBase?: string;
  apiKey?: string;
  runId?: string;
  companyId?: string;
  json?: boolean;
}

export interface ResolvedClientContext {
  api: PaperclipApiClient;
  companyId?: string;
  profileName: string;
  profile: ClientContextProfile;
  json: boolean;
  authSource: "explicit" | "env" | "env_file" | "terminal" | "profile_env" | "stored_board" | "none";
}

export function addCommonClientOptions(command: Command, opts?: { includeCompany?: boolean }): Command {
  command
    .option("-c, --config <path>", "Path to Paperclip config file")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "CLI context profile name")
    .option("--api-base <url>", "Base URL for the Paperclip API")
    .option("--api-key <token>", "Bearer token for agent-authenticated calls; falls back to $PAPERCLIP_API_KEY, then $PAPERCLIP_API_KEY_FILE, then this terminal's own key under ~/.paperclip/keys/")
    .option("--run-id <id>", "Heartbeat run id for agent-authenticated mutations (checkout/release/interactions/in-progress update); falls back to $PAPERCLIP_RUN_ID")
    .option("--json", "Output raw JSON");

  if (opts?.includeCompany) {
    command.option("-C, --company-id <id>", "Company ID (overrides context default)");
  }

  return command;
}

// Single-company deployment (operator's setup, 2026-08-28): every company-scoped
// command works bare. Flag > env > context profile > this constant.
const DEFAULT_COMPANY_ID = "b982ca51-95fb-4ba2-afa6-a3444d6c3c54";

export function resolveCommandContext(
  options: BaseClientOptions,
  opts?: { requireCompany?: boolean },
): ResolvedClientContext {
  const context = readContext(options.context);
  const { name: profileName, profile } = resolveProfile(context, options.profile);

  const apiBase = resolveApiBase(options, profile);

  const resolvedApiKey = resolveApiKey(options, profile);
  const explicitApiKey = resolvedApiKey.value;
  const storedBoardCredential = explicitApiKey ? null : getStoredBoardCredential(apiBase);
  const apiKey = explicitApiKey || storedBoardCredential?.token;

  const companyId =
    options.companyId?.trim() ||
    process.env.PAPERCLIP_COMPANY_ID?.trim() ||
    profile.companyId ||
    DEFAULT_COMPANY_ID;

  if (opts?.requireCompany && !companyId) {
    throw new Error(
      "Company ID is required. Pass --company-id, set PAPERCLIP_COMPANY_ID, or set context profile companyId via `paperclipai context set`.",
    );
  }

  // Agent-authenticated mutations (checkout, release, interactions, PATCH of an
  // in-progress issue) require the X-Paperclip-Run-Id header (the server returns
  // "401 Agent run id required" without it). Source it from --run-id, else the
  // PAPERCLIP_RUN_ID env the adapter/embodiment context already exports.
  const runId = options.runId?.trim() || process.env.PAPERCLIP_RUN_ID?.trim() || undefined;

  const api = new PaperclipApiClient({
    apiBase,
    apiKey,
    runId,
    recoverAuth: explicitApiKey || !canAttemptInteractiveBoardAuth()
      ? undefined
      : async ({ error }) => {
          const requestedAccess = error.message.includes("Instance admin required")
            ? "instance_admin_required"
            : "board";
          if (!shouldRecoverBoardAuth(error)) {
            return null;
          }
          const login = await loginBoardCli({
            apiBase,
            requestedAccess,
            requestedCompanyId: companyId ?? null,
            command: buildCliCommandLabel(),
          });
          return login.token;
        },
  });
  return {
    api,
    companyId,
    profileName,
    profile,
    json: Boolean(options.json),
    authSource: explicitApiKey ? resolvedApiKey.source : storedBoardCredential ? "stored_board" : "none",
  };
}

export function resolveApiBase(options: Pick<BaseClientOptions, "apiBase" | "config">, profile: ClientContextProfile = {}): string {
  return normalizeApiBase(
    options.apiBase?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    profile.apiBase ||
    inferApiBaseFromConfig(options.config),
  );
}

export function normalizeApiBase(apiBase: string): string {
  return apiBase.trim().replace(/\/+$/, "");
}

export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number | boolean | null | undefined>): string {
  let path = strings[0] ?? "";
  values.forEach((value, index) => {
    if (value === null || value === undefined || String(value).trim() === "") {
      throw new Error("Cannot build API path with an empty path segment.");
    }
    path += `${encodeURIComponent(String(value))}${strings[index + 1] ?? ""}`;
  });
  return path;
}

export function inferContentTypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  // These MIME strings are matched against the server's issue-attachment
  // allowlist (server/src/attachment-types.ts DEFAULT_ALLOWED_TYPES) by EXACT
  // string, so text types must carry no "; charset=..." parameter or the upload
  // is rejected with "422 Unsupported attachment content type". Keep this set in
  // sync with that allowlist (plus svg/avif, accepted by the asset routes).
  return {
    avif: "image/avif",
    csv: "text/csv",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    m4v: "video/x-m4v",
    md: "text/markdown",
    mov: "video/quicktime",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    qt: "video/quicktime",
    svg: "image/svg+xml",
    txt: "text/plain",
    webm: "video/webm",
    webp: "image/webp",
    zip: "application/zip",
  }[ext];
}

/**
 * Which terminal is running us, inferred from the variables its own app exports
 * into every child process (MUL-113).
 *
 * Asking each terminal's config to inject the identity failed twice: ZCode's
 * settings.json `env` never reaches Bash children at all, and Codex does not
 * pass it to hook subprocesses, so both silently ran as local-board. These
 * signatures come from the app itself rather than from user config, so there is
 * nothing to configure per machine and nothing to drift.
 *
 * Two defects found live (2026-08-28): CODEX_SANDBOX only exists inside Codex's
 * sandboxed Bash (workspace-write/full-access sessions export CODEX_THREAD_ID
 * instead), and inherited signatures impersonate — a codex exec spawned from a
 * ZCode shell inherits ZCODE_BASE_URL and silently signs as zcode-terminal.
 * Resolution: env signatures are a fast path only when exactly one hits; zero
 * or multiple hits fall through to the process ancestry chain, which names the
 * innermost recognizable host and is immune to environment inheritance.
 */
const TERMINAL_SIGNATURES: Array<{ slug: string; envVars: string[] }> = [
  { slug: "claude-terminal", envVars: ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR"] },
  { slug: "codex-terminal", envVars: ["CODEX_SANDBOX", "CODEX_THREAD_ID"] },
  { slug: "zcode-terminal", envVars: ["ZCODE_BASE_URL"] },
  // Cursor's launcher exports CURSOR_INVOKED_AS on every start. Env can be
  // inherited, so this only decides when ancestry came up empty.
  { slug: "cursor-terminal", envVars: ["CURSOR_INVOKED_AS", "CURSOR_TRACE_ID"] },
];

/** Ancestry matchers: the closest recognizable ancestor is the real host.
 * Patterns must anchor the terminal name at a command boundary (^ or /), never
 * a bare space: a tool call whose own command text merely mentions the word
 * "claude" runs under `/bin/zsh -c '<text>'`, and that zsh is the CLI's direct
 * parent — a space-anchored pattern matched it and the call authenticated as
 * the wrong terminal (2026-08-29, Team Rules rev=46/47 misattributed). */
const TERMINAL_ANCESTRY: Array<{ slug: string; pattern: RegExp }> = [
  { slug: "codex-terminal", pattern: /(^|\/)(codex|codex-darwin-arm64)(\s|$)/ },
  { slug: "claude-terminal", pattern: /(^|\/)claude(\s|$)/ },
  { slug: "zcode-terminal", pattern: /(^|\/)(zcode-cli|zcode-host[-\w]*|ZCode)(\s|$)/ },
  { slug: "qoder", pattern: /(^|\/)Qoder(\s|$)/ },
  // Cursor CLI execs with argv[0] as either `cursor` or the bare `agent` alias,
  // so also match the versioned install path that both forms carry. The IDE's
  // own processes are capital-C `Cursor` and deliberately do not match.
  { slug: "cursor-terminal", pattern: /(^|\/)cursor(-agent)?(\s|$)|cursor-agent\/versions\// },
];

/**
 * Walks the parent-process chain and returns the slug of the closest ancestor
 * that looks like a terminal host. The process tree cannot be inherited the
 * way environment variables can, so a codex spawned from a ZCode shell still
 * resolves as codex-terminal. Returns null in a plain shell.
 */
function detectTerminalByAncestry(): string | null {
  let pid = process.pid;
  for (let depth = 0; depth < 12; depth += 1) {
    let ppid: number;
    let command: string;
    try {
      const ps = execSync(`ps -o ppid=,command= -p ${pid}`, { encoding: "utf8", timeout: 2000 });
      const line = ps.split("\n").find((l) => l.trim().length > 0);
      if (!line) return null;
      const parsed = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!parsed) return null;
      ppid = Number(parsed[1]);
      command = parsed[2];
    } catch {
      return null;
    }
    if (!Number.isFinite(ppid) || ppid <= 1) return null;
    // A shell wrapper carrying `-c` text is a command carrier, never a host:
    // its command line quotes whatever the tool call mentioned (including
    // other terminals' names and paths), so matching it impersonates hosts.
    // Real hosts are standalone binaries further up the chain.
    if (/\/(ba|z|da|k)?sh(\s|$)/.test(command.split(" ")[0]) && /(^|\s)-c(\s|$)/.test(command)) {
      pid = ppid;
      continue;
    }
    for (const matcher of TERMINAL_ANCESTRY) {
      if (matcher.pattern.test(command)) return matcher.slug;
    }
    pid = ppid;
  }
  return null;
}

/**
 * The terminal we appear to be running inside, or null in a plain shell.
 *
 * Ancestry is the primary judge (immune to environment inheritance); env
 * signatures are the fallback for when the chain cannot be walked. A fallback
 * that hits multiple signatures is an error, never a guess: impersonation is
 * the one failure this resolver must never produce (same invariant as a
 * missing key file — fail loudly).
 */
export function detectTerminalSlug(): string | null {
  // Escape hatch for tests and any context that must run unauthenticated:
  // the process tree is real and cannot be cleaned from inside, so an explicit
  // opt-out is the only way to run hostless from inside a terminal.
  if (process.env.PAPERCLIP_NO_TERMINAL_DISCOVERY === "1") return null;
  const byAncestry = detectTerminalByAncestry();
  if (byAncestry) return byAncestry;
  const hits = TERMINAL_SIGNATURES.filter((signature) =>
    signature.envVars.some((name) => (process.env[name] ?? "").trim() !== ""),
  );
  if (hits.length === 1) return hits[0].slug;
  if (hits.length > 1) {
    throw new Error(
      `cannot determine host terminal: signatures for ${hits.map((h) => h.slug).join(" and ")} both present and ancestry was inconclusive — set PAPERCLIP_API_KEY_FILE explicitly`,
    );
  }
  return null;
}

/**
 * The host terminal's session id, from whichever terminal is running us.
 *
 * A navigation aid, not identity: it says which session did something so a
 * later reader can go back and look, and nothing is authorized on its strength.
 *
 * Centralized in MUL-449 after the third copy of this expression appeared.
 * Recall was the case that made it matter: 340 served ledger rows had a null
 * `session_id` because the parameter existed but had to be passed by hand, so
 * "did this session have to search twice" was unanswerable.
 *
 * Now a thin alias over resolveSessionId (MUL-175). The three-variable chain it
 * used to inline read `CODEX_SESSION_ID` and `ZCODE_SESSION_ID`, neither of
 * which any harness exports — so those recall rows were null for Codex and
 * ZCode no matter who passed what. Delegating fixes them here too rather than
 * leaving two helpers that answer the same question differently.
 */
export function detectTerminalSessionId(): string | null {
  return resolveSessionId().sessionId;
}

export function terminalKeyPath(slug: string): string {
  return path.join(os.homedir(), ".paperclip", "keys", slug);
}

/** Just the fields the claim check reads, so callers can pass any issue shape. */
export interface ClaimableIssue {
  id: string;
  identifier?: string | null;
  assigneeAgentId?: string | null;
  drivingAgentId?: string | null;
}

/**
 * 认领防漏（MUL-72）扩面到成果写入（MUL-443）: an agent writing a progress
 * note, advancing status, writing a document or opening a decision on an
 * unclaimed card (no assignee AND no Driving) auto-claims it first — the server
 * 409s all four, and this keeps the CLI path frictionless. Board callers (no
 * /api/agents/me) are untouched.
 *
 * Lives here rather than in issue.ts because the decision command needs it too,
 * and two copies of a claim rule is exactly how the two would drift.
 */
export async function autoClaimIfUnclaimed(ctx: ResolvedClientContext, issue: ClaimableIssue): Promise<void> {
  if (issue.assigneeAgentId || issue.drivingAgentId) return;
  const me = await ctx.api.get<{ id: string } | null>(apiPath`/api/agents/me`).catch(() => null);
  if (!me?.id) return;
  // Resolved through the host's locator (MUL-175) rather than the old
  // three-variable chain: two of those three are exported by nothing, so
  // auto-claims from Codex and ZCode recorded no session at all.
  const drivingSession = resolveSessionId().sessionId;
  // Driving alone is the claim marker (same as the claim command's normal
  // path); assigneeAgentId is left untouched because cards default to
  // assigneeUserId=local-board and setting both trips the one-assignee rule.
  try {
    await ctx.api.patch(apiPath`/api/issues/${issue.id}`, {
      drivingAgentId: me.id,
      ...(drivingSession ? { drivingSession } : {}),
    });
    console.error(`auto-claimed ${issue.identifier ?? issue.id}（Driving 记为本 agent）`);
    issue.drivingAgentId = me.id;
  } catch (err) {
    console.error(`auto-claim failed for ${issue.identifier ?? issue.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The session id to record on a card, resolved through this host's locator
 * (MUL-175).
 *
 * Replaces the `CLAUDE_CODE_SESSION_ID || CODEX_SESSION_ID || ZCODE_SESSION_ID`
 * chain that four call sites each carried their own copy of. Two of those three
 * variables are not exported by anything, so Codex and ZCode had been filing
 * cards with an empty session slot and no complaint — see SESSION_LOCATORS for
 * what each harness actually publishes.
 *
 * Returns the id, or a reason it has none. Callers surface the reason instead
 * of writing a blank, because "this harness publishes no session variable" and
 * "there is no session" are different facts and only the first is normal.
 */
export function resolveSessionId(explicit?: string | null): {
  sessionId: string | null;
  reason: string | null;
} {
  const trimmed = explicit?.trim();
  if (trimmed) return { sessionId: trimmed, reason: null };

  let slug: string | null = null;
  try {
    slug = detectTerminalSlug();
  } catch {
    // Ambiguous host: identity resolution reports this loudly on its own path,
    // and a missing session id must not be the thing that fails a write.
    return { sessionId: null, reason: "host terminal is ambiguous" };
  }

  const locator = sessionLocatorForSlug(slug);
  if (!locator) {
    return { sessionId: null, reason: slug ? `no session locator for ${slug}` : "not running under a recognized terminal" };
  }
  const fromEnv = sessionIdFromEnv(slug, process.env);
  if (fromEnv) return { sessionId: fromEnv, reason: null };
  if (!locator.sessionIdEnv) {
    return { sessionId: null, reason: `${locator.label} publishes no session variable — pass --session, transcripts are at ${locator.transcriptPathTemplate}` };
  }
  return { sessionId: null, reason: `$${locator.sessionIdEnv} is empty — pass --session` };
}

/**
 * Same as resolveSessionId but says so on stderr when it comes up empty. A
 * silently blank session slot is how Codex and ZCode cards lost their session
 * for months; the write still proceeds, the gap is just no longer invisible.
 */
export function resolveSessionIdVerbose(explicit?: string | null): string | null {
  const { sessionId, reason } = resolveSessionId(explicit);
  if (!sessionId && reason) console.error(`session id not recorded: ${reason}`);
  return sessionId;
}

/**
 * Resolves this terminal's key from ~/.paperclip/keys/<slug> with no
 * configuration at all.
 *
 * A plain shell matches no signature and gets no identity, which is the point:
 * an unrecognized caller must never inherit somebody else's name. A recognized
 * terminal whose key file is missing is an error rather than a fallback, for
 * the same reason the env-file source is (see below).
 */
function readKeyFromTerminalDiscovery(): string | undefined {
  const slug = detectTerminalSlug();
  if (!slug) return undefined;

  const filePath = terminalKeyPath(slug);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `This looks like a ${slug} session, but its key file could not be read: ${filePath} (${reason})\n` +
        "Refusing to fall back to an unauthenticated (local-board) request — mint the key in the UI and write it to that path.",
    );
  }

  const value = raw.trim();
  if (!value) {
    throw new Error(
      `This looks like a ${slug} session, but its key file is empty: ${filePath}\n` +
        "Refusing to fall back to an unauthenticated (local-board) request.",
    );
  }

  warnOnLooseKeyFilePermissions(filePath);
  return value;
}

/**
 * Reads the key file named by PAPERCLIP_API_KEY_FILE.
 *
 * Failing loudly is the whole point of this source (MUL-104). The mechanism it
 * replaces — a zshenv branch that skipped itself when the key file was missing
 * — left Codex（Terminal） with no credentials for a day without anyone
 * noticing, because a credential-less CLI silently degrades to local-board and
 * keeps working under the wrong identity. So a file that is set but unusable is
 * a hard exit, never a fallback.
 */
function readKeyFromEnvFile(): string | undefined {
  const filePath = process.env.PAPERCLIP_API_KEY_FILE?.trim();
  if (!filePath) return undefined;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PAPERCLIP_API_KEY_FILE is set to ${filePath} but the file could not be read: ${reason}\n` +
        "Refusing to fall back to an unauthenticated (local-board) request — mint the key in the UI and write it to that path.",
    );
  }

  // `echo` writes a trailing newline; an untrimmed key reaches the server as a
  // malformed bearer token and the 401 says nothing about whitespace.
  const value = raw.trim();
  if (!value) {
    throw new Error(
      `PAPERCLIP_API_KEY_FILE is set to ${filePath} but the file is empty.\n` +
        "Refusing to fall back to an unauthenticated (local-board) request.",
    );
  }

  warnOnLooseKeyFilePermissions(filePath);
  return value;
}

/** A key readable by group or others is a leak waiting to happen, but it still
 *  works, so this warns instead of blocking. */
function warnOnLooseKeyFilePermissions(filePath: string): void {
  try {
    const mode = fs.statSync(filePath).mode & 0o077;
    if (mode !== 0) {
      console.error(
        pc.yellow(
          `warning: ${filePath} is readable by group/other (mode ${(fs.statSync(filePath).mode & 0o777).toString(8)}); run \`chmod 600 ${filePath}\``,
        ),
      );
    }
  } catch {
    // Permission reporting is best-effort; the key already read fine.
  }
}

function resolveApiKey(
  options: Pick<BaseClientOptions, "apiKey">,
  profile: ClientContextProfile,
): { value: string | undefined; source: "explicit" | "env" | "env_file" | "terminal" | "profile_env" | "none" } {
  const optionValue = options.apiKey?.trim();
  if (optionValue) return { value: optionValue, source: "explicit" };

  // The host terminal outranks an ambient PAPERCLIP_API_KEY (decision
  // 910b4a18). Both answer "who am I", but only one of them can lie: the
  // process tree cannot be forged or inherited, while an exported key is
  // inherited by every descendant and outlives whatever set it. A stale export
  // left a Claude session reporting itself as Zcode（Terminal） for hours —
  // silently, which is the one failure this resolver must never produce.
  //
  // `--api-key` still wins, because it is a deliberate, one-shot, visible
  // statement of intent. Exporting a variable is none of those things.
  const terminalValue = readKeyFromTerminalDiscovery();
  if (terminalValue) {
    warnOnOverriddenAmbientKey(terminalValue);
    return { value: terminalValue, source: "terminal" };
  }

  const envValue = process.env.PAPERCLIP_API_KEY?.trim();
  if (envValue) return { value: envValue, source: "env" };

  const envFileValue = readKeyFromEnvFile();
  if (envFileValue) return { value: envFileValue, source: "env_file" };

  const profileEnvValue = readKeyFromProfileEnv(profile);
  if (profileEnvValue) return { value: profileEnvValue, source: "profile_env" };

  return { value: undefined, source: "none" };
}

/** Says so when an exported key was ignored, so the stale export gets cleaned
 *  up instead of quietly disagreeing with the terminal forever. */
function warnOnOverriddenAmbientKey(usedKey: string): void {
  const ambient = process.env.PAPERCLIP_API_KEY?.trim();
  if (!ambient || ambient === usedKey) return;
  console.error(
    pc.yellow(
      "warning: ignoring PAPERCLIP_API_KEY — it disagrees with this terminal's own key. " +
        "Using the terminal's key from ~/.paperclip/keys/. Pass --api-key to override deliberately.",
    ),
  );
}

function shouldRecoverBoardAuth(error: ApiRequestError): boolean {
  if (error.status === 401) return true;
  if (error.status !== 403) return false;
  return error.message.includes("Board access required") || error.message.includes("Instance admin required");
}

function canAttemptInteractiveBoardAuth(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function printOutput(data: unknown, opts: { json?: boolean; label?: string } = {}): void {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (opts.label) {
    console.log(pc.bold(opts.label));
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log(pc.dim("(empty)"));
      return;
    }
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        console.log(formatInlineRecord(item as Record<string, unknown>));
      } else {
        console.log(String(item));
      }
    }
    return;
  }

  if (typeof data === "object" && data !== null) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data === undefined || data === null) {
    console.log(pc.dim("(null)"));
    return;
  }

  console.log(String(data));
}

export function formatInlineRecord(record: Record<string, unknown>): string {
  const keyOrder = ["identifier", "id", "name", "status", "priority", "title", "action"];
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const key of keyOrder) {
    if (!(key in record)) continue;
    parts.push(`${key}=${renderValue(record[key])}`);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(record)) {
    if (seen.has(key)) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${renderValue(value)}`);
  }

  return parts.join(" ");
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 90 ? `${compact.slice(0, 87)}...` : compact;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "[object]";
}

export function inferApiBaseFromConfig(configPath?: string): string {
  const envHost = process.env.PAPERCLIP_SERVER_HOST?.trim() || "localhost";
  let port = Number(process.env.PAPERCLIP_SERVER_PORT || "");

  if (!Number.isFinite(port) || port <= 0) {
    try {
      const config = readConfig(configPath);
      port = Number(config?.server?.port ?? 3100);
    } catch {
      port = 3100;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    port = 3100;
  }

  return `http://${envHost}:${port}`;
}

function readKeyFromProfileEnv(profile: ClientContextProfile): string | undefined {
  if (!profile.apiKeyEnvVarName) return undefined;
  return process.env[profile.apiKeyEnvVarName]?.trim() || undefined;
}

export function handleCommandError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    const detailSuffix = error.details !== undefined ? ` details=${JSON.stringify(error.details)}` : "";
    console.error(pc.red(`API error ${error.status}: ${error.message}${detailSuffix}`));
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exit(1);
}


// 文档骨架正文住在 shared（Team Templates 页面和 CLI 读同一份），这里只转出去。
export { DOCUMENT_SKELETONS, DOCUMENT_SKELETON_KEYS, documentSkeleton } from "@paperclipai/shared/document-skeletons";

/**
 * 漏回写检测 (MUL-489)：某条正文写着「推翻第 N 条」，而第 N 条的状态行还是
 * 「已定」。骨架要求这两件事在同一次 put 里完成，但它只是一句话没有检查，实测
 * MUL-485 写到 22 条时回写 0 次，作废条目一直被 `decisions:pull` 算成有效。
 *
 * 只认带编号的写法（`推翻第 N 条` / `推翻本卡第 N 条`）。正文里「推翻原因」这类
 * 字段名、以及「推翻本卡技术方案的一处边界」这种不指向条目的说法都不该命中，
 * 所以编号是必须的，不做模糊匹配。
 *
 * 只报不拦：它读的是已经写下来的两处自相矛盾，属客观事实；而「你没写术语表」
 * 那类要判断该不该写的事，不在这里管。
 */
export function findUnwrittenOverturns(
  entries: DecisionLogEntry[],
): Array<{ by: number; target: number }> {
  const byNumber = new Map(entries.map((e) => [e.number, e]));
  const seen = new Set<string>();
  const out: Array<{ by: number; target: number }> = [];
  for (const entry of entries) {
    for (const m of entry.body.matchAll(/推翻(?:本卡)?第\s*(\d+)\s*条/g)) {
      const target = Number(m[1]);
      const hit = byNumber.get(target);
      if (!hit || hit.number === entry.number) continue;
      if (hit.status.includes("已被")) continue;
      const key = `${entry.number}->${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ by: entry.number, target });
    }
  }
  return out;
}


/**
 * 标准 key 的中文名。不在表里的 key 直接用 key 本身当名字——目的是「每份文档都有
 * 标题」，不是「每个 key 都得先登记」，所以不设白名单门禁。
 */
const DOCUMENT_TITLE_NAMES: Record<string, string> = {
  requirements: "需求设计",
  "tech-proposal": "技术方案",
  spec: "实现 Spec",
  glossary: "本卡术语",
  plan: "拆解计划",
};

/**
 * 没给 `--title` 时的默认标题。拿不到卡号就返回 null 而不是编一个——标题里的卡号
 * 是给人脱离卡单看时定位用的，编错了比没有更坏。
 */
export function defaultDocumentTitle(key: string, identifier: string | null | undefined): string | null {
  const card = (identifier ?? "").trim();
  if (!card) return null;
  const name = DOCUMENT_TITLE_NAMES[key.trim().toLowerCase()] ?? key.trim();
  return `${name} · ${card}`;
}

/**
 * 决策正文死模板（MUL-49 收口，MUL-86 升级为 CLI+服务端双层强制）：背景 /
 * 判断标准 / 方案 三节缺一不可。The section matcher lives in shared
 * (missingDecisionBodySections) so the CLI check and the server's create-route
 * gate stay one implementation.
 */
export function assertDecisionBodyTemplate(body: string): void {
  const missing = missingDecisionBodySections(body);
  if (missing.length > 0) {
    throw new Error(
      `决策正文缺节：${missing.join("、")} —— 三段死模板（背景 / 判断标准 / 方案）缺一不可，每个方案带自己的代价`,
    );
  }
}
