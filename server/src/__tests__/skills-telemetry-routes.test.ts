import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const skillsUsage = vi.fn();
const skillsLocalStatus = vi.fn();

vi.mock("../services/skills-telemetry.js", () => ({
  skillsUsage: (...args: unknown[]) => skillsUsage(...args),
  skillsLocalStatus: (...args: unknown[]) => skillsLocalStatus(...args),
}));

const { companySkillRoutes } = await import("../routes/company-skills.js");
const { errorHandler } = await import("../middleware/index.js");

const COMPANY = "11111111-2222-3333-4444-555555555555";

function app() {
  const instance = express();
  instance.use((req, _res, next) => {
    (req as express.Request & { actor?: unknown }).actor = { type: "agent", companyId: COMPANY, agentId: "test" };
    next();
  });
  instance.use("/api", companySkillRoutes({} as never));
  instance.use(errorHandler);
  return instance;
}

describe("skill telemetry routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The literal segments sit in the same namespace as `/skills/:skillId`;
  // registered after it they would be read as skill ids and 404.
  it("routes /skills/usage to the collector rather than the :skillId detail route", async () => {
    skillsUsage.mockResolvedValue({ days: 30, totalCalls: 7, skills: [] });
    const res = await request(app()).get(`/api/companies/${COMPANY}/skills/usage?days=7`);
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(7);
    expect(skillsUsage).toHaveBeenCalledWith(7);
  });

  it("defaults the window to 30 days and rejects a non-positive one", async () => {
    skillsUsage.mockResolvedValue({ days: 30, totalCalls: 0, skills: [] });
    await request(app()).get(`/api/companies/${COMPANY}/skills/usage`);
    expect(skillsUsage).toHaveBeenCalledWith(30);

    const bad = await request(app()).get(`/api/companies/${COMPANY}/skills/usage?days=0`);
    expect(bad.status).toBe(400);
  });

  it("answers 404 when there is no checkout, never an empty and therefore clean table", async () => {
    skillsLocalStatus.mockResolvedValue(null);
    const res = await request(app()).get(`/api/companies/${COMPANY}/skills/local-status`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/checkout/i);
  });

  it("returns the projection table when a checkout is present", async () => {
    skillsLocalStatus.mockResolvedValue({ repoRoot: "/repo", tools: ["codex"], fanoutAvailable: true, skills: [] });
    const res = await request(app()).get(`/api/companies/${COMPANY}/skills/local-status`);
    expect(res.status).toBe(200);
    expect(res.body.repoRoot).toBe("/repo");
    expect(skillsLocalStatus).toHaveBeenCalledWith(COMPANY);
  });
});
