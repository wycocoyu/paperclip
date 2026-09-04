import { issues } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";

/**
 * MUL-538: auto-dispatch pause.
 *
 * In Paperclip an assignment is standing state and the issue status is the
 * gate: `reconcileStrandedAssignedIssues` picks up every card that has an
 * `assigneeAgentId` and sits in `todo` / `in_progress` / `in_review`. `done` is
 * outside that set, so flipping a finished card back to an open status re-arms
 * an assignee nobody was thinking about and the agent starts running by itself.
 *
 * The pause flag holds that back per card without clearing the assignee, which
 * also carries "whose work is this" for progress accounting. Crash recovery is
 * deliberately still allowed through — an unsuccessful terminal run is the
 * reason the stranded sweep exists at all.
 */

/** Statuses a card must leave for the reopen-pause to apply. */
const TERMINAL_STATUSES = new Set<string>(["done", "cancelled"]);

/** Reads the flag off a card. Absent, null and non-boolean all mean not paused. */
export function isAutoDispatchPaused(
  issue: Pick<typeof issues.$inferSelect, "executionPolicy">,
) {
  return parseObject(issue.executionPolicy).autoDispatchPaused === true;
}

/** A caller's own autoDispatchPaused, or undefined when they did not say. */
export function readAutoDispatchPausedInput(executionPolicy: unknown): boolean | undefined {
  const value = parseObject(executionPolicy).autoDispatchPaused;
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Whether this status transition should pause the card's auto-dispatch.
 *
 * An explicit value from the caller always wins, so "reopen this and run it"
 * stays a single request rather than a reopen followed by an un-pause.
 */
export function shouldPauseAutoDispatchOnReopen(input: {
  fromStatus: string;
  toStatus: string | undefined;
  explicitPause: boolean | undefined;
}) {
  if (!input.toStatus) return false;
  if (input.explicitPause !== undefined) return false;
  return TERMINAL_STATUSES.has(input.fromStatus) && !TERMINAL_STATUSES.has(input.toStatus);
}

/**
 * Run statuses that mean the previous attempt died rather than finished. Kept
 * in step with `UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES` in the recovery
 * service — that list is the definition, this one exists so the gate below can
 * be tested without standing up the whole sweep.
 */
const UNSUCCESSFUL_RUN_STATUSES = new Set<string>([
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * The stranded-sweep gate: skip a paused card unless its last run died.
 *
 * A card with no run at all counts as "did not die" — nothing crashed, so
 * picking it up would be a fresh dispatch, which is exactly what the pause is
 * for. Crash recovery keeps working because a failed / interrupted / cancelled
 * / timed-out run puts the card back in scope regardless of the pause.
 */
export function shouldSkipStrandedSweep(input: {
  issue: Pick<typeof issues.$inferSelect, "executionPolicy">;
  latestRunStatus: string | null | undefined;
}) {
  if (!isAutoDispatchPaused(input.issue)) return false;
  return !UNSUCCESSFUL_RUN_STATUSES.has(input.latestRunStatus ?? "");
}
