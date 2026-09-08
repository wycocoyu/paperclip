import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  teamRuleNoteVersions,
  teamRuleNotes,
  teamWikiPageVersions,
  teamWikiPages,
} from "@paperclipai/db";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";
import { teamRulesRoutes } from "../routes/team-rules.js";
import { teamWikiRoutes } from "../routes/team-wiki.js";
import {
  configureTeamDocFanout,
  resetTeamDocFanoutForTests,
  setTeamDocFanoutSinksForTests,
  teamDocFanoutFailures,
  type TeamDocFanoutSink,
  type TeamRulesSnapshot,
  type TeamWikiPageSnapshot,
} from "../services/team-doc-fanout.js";
import { openVikingSink } from "../services/team-doc-ov-sink.js";

/**
 * MUL-559 step 4a red/green.
 *
 * The forced failure is a real one, not a probe: an agent actor whose agent row
 * does not exist trips the `author_agent_id` foreign key on the *version*
 * insert while the note/page UPDATE itself is perfectly valid. Before the fix
 * that combination left the body saved with no version recording it; the
 * transaction is what makes it all-or-nothing.
 */

const GHOST_AGENT: BoardActor = {
  type: "agent",
  source: "agent_key",
  // Not in `agents`, so any write carrying it as author_agent_id is rejected.
  agentId: randomUUID(),
  keyId: null,
  runId: null,
} as unknown as BoardActor;

describeEmbeddedPostgres("team rules/wiki version atomicity", () => {
  const ctx = useEmbeddedPostgres("team-doc-atomicity");

  let companyId: string;
  let boardActor: BoardActor;
  let agentActor: BoardActor;

  const delivered: { rules: TeamRulesSnapshot[]; wiki: TeamWikiPageSnapshot[] } = { rules: [], wiki: [] };
  let failNextDelivery = false;
  /** Held open to keep one delivery in flight while more publishes arrive. */
  let gate: Promise<void> | null = null;

  const recorder: TeamDocFanoutSink = {
    name: "recorder",
    async deliverRules(snapshot) {
      if (gate) await gate;
      if (failNextDelivery) throw new Error("sink is down");
      delivered.rules.push(snapshot);
      return "ok";
    },
    async deliverWikiPage(snapshot) {
      if (failNextDelivery) throw new Error("sink is down");
      delivered.wiki.push(snapshot);
      return "ok";
    },
    async retireWikiPage() {
      return "removed";
    },
  };

  beforeEach(async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "team-doc");
    companyId = seeded.companyId;
    boardActor = seeded.actor;
    agentActor = { ...GHOST_AGENT, companyId } as unknown as BoardActor;
    delivered.rules = [];
    delivered.wiki = [];
    failNextDelivery = false;
    gate = null;
    resetTeamDocFanoutForTests();
    setTeamDocFanoutSinksForTests([recorder]);
    configureTeamDocFanout({ ovBin: "/nonexistent/ov", companyId });
  });

  afterEach(() => {
    resetTeamDocFanoutForTests();
    setTeamDocFanoutSinksForTests([openVikingSink]);
  });

  const rulesApp = () => routeApp(ctx.db, boardActor, teamRulesRoutes);
  const rulesAppAsGhost = () => routeApp(ctx.db, agentActor, teamRulesRoutes);
  const wikiApp = () => routeApp(ctx.db, boardActor, teamWikiRoutes);
  const wikiAppAsGhost = () => routeApp(ctx.db, agentActor, teamWikiRoutes);

  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  async function waitFor(cond: () => boolean, label: string, budgetMs = 4_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function ruleVersions(noteId: string) {
    return await ctx.db
      .select({ id: teamRuleNoteVersions.id, body: teamRuleNoteVersions.body })
      .from(teamRuleNoteVersions)
      .where(and(eq(teamRuleNoteVersions.noteId, noteId), eq(teamRuleNoteVersions.companyId, companyId)));
  }

  async function seedNote(): Promise<{ id: string; body: string }> {
    const res = await request(rulesApp())
      .post(`/api/companies/${companyId}/team-rules/notes`)
      .send({ title: "Rules", body: "original body" });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function seedPage(): Promise<{ id: string; body: string; path: string }> {
    const res = await request(wikiApp())
      .post(`/api/companies/${companyId}/team-wiki/agent/pages`)
      .send({ title: "Page", path: "guide/one", body: "original body" });
    expect(res.status).toBe(201);
    return res.body;
  }

  it("rolls the note body back when the version insert fails", async () => {
    const note = await seedNote();
    await settle();
    delivered.rules = [];

    const res = await request(rulesAppAsGhost())
      .patch(`/api/companies/${companyId}/team-rules/notes/${note.id}`)
      .send({ body: "edited body" });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const [stored] = await ctx.db
      .select({ body: teamRuleNotes.body })
      .from(teamRuleNotes)
      .where(eq(teamRuleNotes.id, note.id));
    expect(stored.body).toBe("original body");
    expect(await ruleVersions(note.id)).toHaveLength(1);

    await settle();
    expect(delivered.rules).toEqual([]);
  });

  it("rolls the note back when a restore's version insert fails", async () => {
    const note = await seedNote();
    await request(rulesApp())
      .patch(`/api/companies/${companyId}/team-rules/notes/${note.id}`)
      .send({ body: "second body" })
      .expect(200);
    await settle();
    delivered.rules = [];

    const res = await request(rulesAppAsGhost())
      .post(`/api/companies/${companyId}/team-rules/notes/${note.id}/versions/1/restore`);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const [stored] = await ctx.db
      .select({ body: teamRuleNotes.body })
      .from(teamRuleNotes)
      .where(eq(teamRuleNotes.id, note.id));
    expect(stored.body).toBe("second body");
    expect(await ruleVersions(note.id)).toHaveLength(2);
    await settle();
    expect(delivered.rules).toEqual([]);
  });

  it("rolls the wiki page body back when the version insert fails", async () => {
    const page = await seedPage();
    await settle();
    delivered.wiki = [];

    const res = await request(wikiAppAsGhost())
      .patch(`/api/companies/${companyId}/team-wiki/agent/pages/${page.id}`)
      .send({ body: "edited body" });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const [stored] = await ctx.db
      .select({ body: teamWikiPages.body })
      .from(teamWikiPages)
      .where(eq(teamWikiPages.id, page.id));
    expect(stored.body).toBe("original body");
    const versions = await ctx.db
      .select({ id: teamWikiPageVersions.id })
      .from(teamWikiPageVersions)
      .where(eq(teamWikiPageVersions.pageId, page.id));
    expect(versions).toHaveLength(1);

    await settle();
    expect(delivered.wiki).toEqual([]);
  });

  it("fans out once per committed save and carries the newest body", async () => {
    const note = await seedNote();
    await waitFor(() => delivered.rules.length === 1, "initial rules delivery");
    expect(delivered.rules[0].notes.map((n) => n.body)).toEqual(["original body"]);

    const page = await seedPage();
    await waitFor(() => delivered.wiki.length === 1, "initial wiki delivery");
    expect(delivered.wiki[0]).toMatchObject({ pageId: page.id, path: "guide/one", body: "original body" });

    // A reorder-only PATCH appends no version, so it must fan out nothing.
    delivered.rules = [];
    await request(rulesApp())
      .patch(`/api/companies/${companyId}/team-rules/notes/${note.id}`)
      .send({ position: 5 })
      .expect(200);
    await settle();
    expect(delivered.rules).toEqual([]);
  });

  it("collapses saves that land while a delivery is in flight", async () => {
    const note = await seedNote();
    await waitFor(() => delivered.rules.length === 1, "initial rules delivery");
    delivered.rules = [];

    // The first save's delivery parks inside the sink; the next two queue
    // behind it and must collapse into a single run of the newest text.
    let release = () => {};
    gate = new Promise<void>((resolve) => { release = resolve; });
    for (const body of ["v1", "v2", "v3"]) {
      await request(rulesApp())
        .patch(`/api/companies/${companyId}/team-rules/notes/${note.id}`)
        .send({ body })
        .expect(200);
    }
    expect(delivered.rules).toEqual([]);
    release();
    gate = null;

    await waitFor(() => delivered.rules.length >= 2, "burst deliveries");
    await settle();
    expect(delivered.rules).toHaveLength(2);
    expect(delivered.rules.at(-1)?.notes.map((n) => n.body)).toEqual(["v3"]);
  });

  it("parks a delivery that keeps failing on the queryable failures list", async () => {
    failNextDelivery = true;
    const note = await seedNote();
    await waitFor(
      () => teamDocFanoutFailures(companyId).length === 1,
      "rules delivery parked as a failure",
      40_000,
    );
    const [failure] = teamDocFanoutFailures(companyId);
    expect(failure).toMatchObject({ kind: "rules", entityId: note.id, attempts: 6 });
    expect(failure.lastError).toContain("sink is down");
    expect(teamDocFanoutFailures(randomUUID())).toEqual([]);
  }, 60_000);
});
