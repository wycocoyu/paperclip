import { describe, expect, it } from "vitest";
import {
  isAutoDispatchPaused,
  readAutoDispatchPausedInput,
  shouldPauseAutoDispatchOnReopen,
  shouldSkipStrandedSweep,
} from "./auto-dispatch-pause.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

describe("isAutoDispatchPaused", () => {
  it("reads the flag off execution_policy", () => {
    expect(isAutoDispatchPaused({ executionPolicy: { autoDispatchPaused: true } })).toBe(true);
  });

  it("treats absent, null and false as not paused", () => {
    expect(isAutoDispatchPaused({ executionPolicy: null })).toBe(false);
    expect(isAutoDispatchPaused({ executionPolicy: {} })).toBe(false);
    expect(isAutoDispatchPaused({ executionPolicy: { autoDispatchPaused: false } })).toBe(false);
  });

  it("ignores a non-boolean value rather than treating it as paused", () => {
    expect(isAutoDispatchPaused({ executionPolicy: { autoDispatchPaused: "true" } })).toBe(false);
  });
});

describe("readAutoDispatchPausedInput", () => {
  it("distinguishes an explicit false from not saying", () => {
    expect(readAutoDispatchPausedInput({ autoDispatchPaused: false })).toBe(false);
    expect(readAutoDispatchPausedInput({})).toBeUndefined();
    expect(readAutoDispatchPausedInput(null)).toBeUndefined();
  });
});

describe("shouldPauseAutoDispatchOnReopen", () => {
  it("pauses when a finished card goes back to an open status", () => {
    for (const from of ["done", "cancelled"]) {
      for (const to of ["todo", "in_progress", "in_review", "blocked", "backlog"]) {
        expect(
          shouldPauseAutoDispatchOnReopen({ fromStatus: from, toStatus: to, explicitPause: undefined }),
        ).toBe(true);
      }
    }
  });

  it("does not pause a transition between two open statuses", () => {
    expect(
      shouldPauseAutoDispatchOnReopen({ fromStatus: "todo", toStatus: "in_progress", explicitPause: undefined }),
    ).toBe(false);
  });

  it("does not pause when the card is being finished", () => {
    expect(
      shouldPauseAutoDispatchOnReopen({ fromStatus: "in_progress", toStatus: "done", explicitPause: undefined }),
    ).toBe(false);
  });

  it("does not pause a done -> cancelled move, since neither is open", () => {
    expect(
      shouldPauseAutoDispatchOnReopen({ fromStatus: "done", toStatus: "cancelled", explicitPause: undefined }),
    ).toBe(false);
  });

  it("does nothing when the request carries no status at all", () => {
    expect(
      shouldPauseAutoDispatchOnReopen({ fromStatus: "done", toStatus: undefined, explicitPause: undefined }),
    ).toBe(false);
  });

  it("lets an explicit value win, so reopen-and-run stays one request", () => {
    expect(
      shouldPauseAutoDispatchOnReopen({ fromStatus: "done", toStatus: "in_progress", explicitPause: false }),
    ).toBe(false);
    expect(
      shouldPauseAutoDispatchOnReopen({ fromStatus: "done", toStatus: "in_progress", explicitPause: true }),
    ).toBe(false);
  });
});

describe("normalizeIssueExecutionPolicy keeps the pause flag", () => {
  it("survives normalisation when it is the only field", () => {
    const policy = normalizeIssueExecutionPolicy({ autoDispatchPaused: true });
    expect(policy).not.toBeNull();
    expect(policy?.autoDispatchPaused).toBe(true);
  });

  it("survives normalisation alongside other policy fields", () => {
    const policy = normalizeIssueExecutionPolicy({ mode: "normal", stages: [], autoDispatchPaused: true });
    expect(policy?.autoDispatchPaused).toBe(true);
  });

  it("keeps an explicit un-pause rather than dropping it back to the default", () => {
    expect(normalizeIssueExecutionPolicy({ autoDispatchPaused: false })?.autoDispatchPaused).toBe(false);
  });

  it("still collapses a policy that carries nothing at all", () => {
    expect(normalizeIssueExecutionPolicy({ stages: [] })).toBeNull();
  });
});

describe("shouldSkipStrandedSweep", () => {
  const paused = { executionPolicy: { autoDispatchPaused: true } };
  const notPaused = { executionPolicy: null };

  it("never skips a card that is not paused, whatever its last run did", () => {
    for (const status of ["succeeded", "failed", "running", null, undefined]) {
      expect(shouldSkipStrandedSweep({ issue: notPaused, latestRunStatus: status })).toBe(false);
    }
  });

  it("skips a paused card whose last run finished cleanly", () => {
    expect(shouldSkipStrandedSweep({ issue: paused, latestRunStatus: "succeeded" })).toBe(true);
  });

  it("skips a paused card that has never run — nothing crashed, so this is a fresh dispatch", () => {
    expect(shouldSkipStrandedSweep({ issue: paused, latestRunStatus: null })).toBe(true);
    expect(shouldSkipStrandedSweep({ issue: paused, latestRunStatus: undefined })).toBe(true);
  });

  it("still recovers a paused card whose last run died", () => {
    for (const status of ["interrupted", "failed", "cancelled", "timed_out"]) {
      expect(shouldSkipStrandedSweep({ issue: paused, latestRunStatus: status })).toBe(false);
    }
  });
});
