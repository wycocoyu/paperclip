import { api } from "./client";

/**
 * Wire shapes for the two read-only skill-telemetry routes. The server answers
 * them from `@paperclipai/skill-materializer`, which is Node-only code (it
 * streams transcripts and stats symlinks), so the browser mirrors the shape
 * rather than importing it.
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
  unreadable: Array<{ file: string; error: string }>;
  skills: SkillUsageRow[];
}

export type TerminalSkillTool = "codex" | "claude" | "kimi" | "zcode" | "cursor" | "custom";

export interface SkillFanoutFailure {
  skillId: string;
  lastError: string;
  attempts: number;
  lastAttemptAt: string;
}

export interface SkillStatusRow {
  name: string;
  source: string;
  sourceLabel: "team" | "upstream";
  skillId: string | null;
  links: Record<TerminalSkillTool, { state: string; to?: string }>;
  /** Absent (not null) when there is no sidecar to compare against. */
  drift?: string | null;
  fanout: SkillFanoutFailure | null | "unknown";
}

export interface SkillsStatusResult {
  repoRoot: string;
  tools: TerminalSkillTool[];
  fanoutAvailable: boolean;
  fanoutReason?: string;
  skills: SkillStatusRow[];
}

export const skillsTelemetryApi = {
  usage: (companyId: string, days: number) =>
    api.get<SkillsUsageResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/usage?days=${days}`,
    ),
  localStatus: (companyId: string) =>
    api.get<SkillsStatusResult>(`/companies/${encodeURIComponent(companyId)}/skills/local-status`),
};
