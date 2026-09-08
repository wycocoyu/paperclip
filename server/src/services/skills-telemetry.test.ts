import { beforeEach, describe, expect, it, vi } from "vitest";

const collectSkillsUsage = vi.fn();

vi.mock("@paperclipai/skill-materializer", () => ({
  collectSkillsUsage: (...args: unknown[]) => collectSkillsUsage(...args),
  collectSkillsStatus: vi.fn(),
  resolvePaperclipRepoRoot: vi.fn(async () => null),
}));

const { skillsUsage, skillsUsageCacheReset } = await import("./skills-telemetry.js");

describe("skillsUsage caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillsUsageCacheReset();
  });

  // A cold scan is ~20s of transcript walking. Two openers of the page must not
  // start two of them, and a reload seconds later must not start a third.
  it("collapses concurrent scans of one window into a single pass", async () => {
    let release!: (value: unknown) => void;
    collectSkillsUsage.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const both = Promise.all([skillsUsage(30), skillsUsage(30)]);
    expect(collectSkillsUsage).toHaveBeenCalledTimes(1);
    release({ totalCalls: 3 });
    expect(await both).toEqual([{ totalCalls: 3 }, { totalCalls: 3 }]);
  });

  it("serves a repeat within the TTL from memory and rescans after it", async () => {
    collectSkillsUsage.mockResolvedValue({ totalCalls: 3 });
    await skillsUsage(30, 1_000);
    await skillsUsage(30, 1_000 + 59_000);
    expect(collectSkillsUsage).toHaveBeenCalledTimes(1);

    await skillsUsage(30, 1_000 + 61_000);
    expect(collectSkillsUsage).toHaveBeenCalledTimes(2);
  });

  it("keeps windows apart so switching the range is not a cache hit", async () => {
    collectSkillsUsage.mockResolvedValue({ totalCalls: 3 });
    await skillsUsage(30);
    await skillsUsage(7);
    expect(collectSkillsUsage).toHaveBeenCalledTimes(2);
    expect(collectSkillsUsage).toHaveBeenNthCalledWith(1, { days: 30, cache: true });
    expect(collectSkillsUsage).toHaveBeenNthCalledWith(2, { days: 7, cache: true });
  });
});
