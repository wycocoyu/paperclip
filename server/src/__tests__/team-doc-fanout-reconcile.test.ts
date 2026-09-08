import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { teamDocFanoutWatermarks, teamWikiPages } from "@paperclipai/db";
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
  publishTeamWikiVersionPublished,
  reconcileTeamDocFanoutOnStartup,
  resetTeamDocFanoutForTests,
  setTeamDocFanoutSinksForTests,
  type TeamDocFanoutSink,
  type TeamRulesSnapshot,
  type TeamWikiPageRef,
  type TeamWikiPageSnapshot,
} from "../services/team-doc-fanout.js";
import { openVikingSink } from "../services/team-doc-ov-sink.js";

/**
 * MUL-559 acceptance criterion 7, for Team Rules and Team Wiki.
 *
 * Skills recover from "committed, then killed before the projection ran" by
 * reading the sidecar the materializer left on disk. OpenViking is remote and
 * leaves nothing to read back, so the recovery has to be a delivery watermark
 * in the database — and a watermark is only worth having if it advances after
 * the push and not before.
 *
 * The lost delivery is reproduced by writing the row the way a crash leaves it:
 * body committed, no fan-out event. A route call would deliver it immediately
 * and prove nothing.
 */
describeEmbeddedPostgres("team doc fan-out startup reconciliation", () => {
  const ctx = useEmbeddedPostgres("team-doc-reconcile");

  let companyId: string;
  let boardActor: BoardActor;

  const delivered: { rules: TeamRulesSnapshot[]; wiki: TeamWikiPageSnapshot[] } = { rules: [], wiki: [] };
  const retired: TeamWikiPageRef[] = [];
  let sinkIsDown = false;
  let retireIsDown = false;

  const recorder: TeamDocFanoutSink = {
    name: "recorder",
    async deliverRules(snapshot) {
      if (sinkIsDown) throw new Error("sink is down");
      delivered.rules.push(snapshot);
      return "ok";
    },
    async deliverWikiPage(snapshot) {
      if (sinkIsDown) throw new Error("sink is down");
      delivered.wiki.push(snapshot);
      return "ok";
    },
    async retireWikiPage(previous) {
      if (retireIsDown) throw new Error("ov rm is down");
      retired.push(previous);
      return "removed";
    },
  };

  beforeEach(async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "team-doc-recon");
    companyId = seeded.companyId;
    boardActor = seeded.actor;
    delivered.rules = [];
    delivered.wiki = [];
    retired.length = 0;
    sinkIsDown = false;
    retireIsDown = false;
    resetTeamDocFanoutForTests();
    setTeamDocFanoutSinksForTests([recorder]);
    configureTeamDocFanout({ ovBin: "/nonexistent/ov", companyId });
  });

  afterEach(() => {
    resetTeamDocFanoutForTests();
    setTeamDocFanoutSinksForTests([openVikingSink]);
  });

  const rulesApp = () => routeApp(ctx.db, boardActor, teamRulesRoutes);
  const wikiApp = () => routeApp(ctx.db, boardActor, teamWikiRoutes);

  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  async function waitFor(cond: () => boolean, label: string, budgetMs = 5_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function watermarks(): Promise<Map<string, string>> {
    const rows = await ctx.db
      .select({ scope: teamDocFanoutWatermarks.scope, contentHash: teamDocFanoutWatermarks.contentHash })
      .from(teamDocFanoutWatermarks)
      .where(eq(teamDocFanoutWatermarks.companyId, companyId));
    return new Map(rows.map((row) => [row.scope, row.contentHash]));
  }

  async function deliveredPath(pageId: string): Promise<string | null> {
    const rows = await ctx.db
      .select({ path: teamDocFanoutWatermarks.deliveredPath })
      .from(teamDocFanoutWatermarks)
      .where(and(
        eq(teamDocFanoutWatermarks.companyId, companyId),
        eq(teamDocFanoutWatermarks.scope, `wiki/${pageId}`),
      ));
    return rows[0]?.path ?? null;
  }

  async function seedNote(): Promise<{ id: string }> {
    const res = await request(rulesApp())
      .post(`/api/companies/${companyId}/team-rules/notes`)
      .send({ title: "Rules", body: "original body" });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function seedPage(path = "guide/one"): Promise<{ id: string }> {
    const res = await request(wikiApp())
      .post(`/api/companies/${companyId}/team-wiki/agent/pages`)
      .send({ title: "Page", path, body: "original body" });
    expect(res.status).toBe(201);
    return res.body;
  }

  it("records a watermark once every sink has taken the delivery", async () => {
    const note = await seedNote();
    const page = await seedPage();
    await waitFor(() => delivered.rules.length > 0 && delivered.wiki.length > 0, "first delivery");
    await settle();

    const marks = await watermarks();
    expect([...marks.keys()].sort()).toEqual(["rules", `wiki/${page.id}`]);
    expect(marks.get("rules")).toMatch(/^[0-9a-f]{64}$/);
    expect(note.id).toBeTruthy();
  });

  it("leaves the watermark unwritten while the sink is failing", async () => {
    sinkIsDown = true;
    const page = await seedPage();
    await settle();
    expect(delivered.wiki).toHaveLength(0);
    expect((await watermarks()).has(`wiki/${page.id}`)).toBe(false);

    // The queue's own retry is what closes the gap; nothing else re-arms it.
    sinkIsDown = false;
    await waitFor(() => delivered.wiki.length > 0, "retry after the sink recovers");
    await settle();
    expect((await watermarks()).has(`wiki/${page.id}`)).toBe(true);
  });

  it("queues only what drifted while the process was down", async () => {
    await seedNote();
    const stale = await seedPage("guide/stale");
    const fresh = await seedPage("guide/fresh");
    await waitFor(() => delivered.wiki.length === 2, "initial deliveries");
    await settle();

    // A crash between commit and fan-out leaves exactly this: a committed body
    // with no event behind it.
    await ctx.db
      .update(teamWikiPages)
      .set({ body: "written while the fan-out was dead" })
      .where(and(eq(teamWikiPages.id, stale.id), eq(teamWikiPages.companyId, companyId)));

    delivered.rules = [];
    delivered.wiki = [];
    const result = await reconcileTeamDocFanoutOnStartup(ctx.db);
    expect(result).toEqual({ scanned: 3, queued: 1, upToDate: 2 });

    await waitFor(() => delivered.wiki.length > 0, "reconciled delivery");
    await settle();
    expect(delivered.wiki.map((snapshot) => snapshot.pageId)).toEqual([stale.id]);
    expect(delivered.wiki[0]?.body).toBe("written while the fan-out was dead");
    expect(delivered.rules).toHaveLength(0);
    expect(fresh.id).toBeTruthy();

    // Second boot with nothing lost: no traffic at all.
    expect(await reconcileTeamDocFanoutOnStartup(ctx.db)).toEqual({ scanned: 3, queued: 0, upToDate: 3 });
  });

  it("retires the delivered copy and drops the watermark for a page that is gone", async () => {
    const page = await seedPage();
    await waitFor(() => delivered.wiki.length > 0, "first delivery");
    await settle();
    expect((await watermarks()).has(`wiki/${page.id}`)).toBe(true);

    await ctx.db.delete(teamWikiPages).where(eq(teamWikiPages.id, page.id));
    publishTeamWikiVersionPublished(ctx.db, { companyId, pageId: page.id });
    await waitFor(() => retired.length > 0, "retirement of the deleted page");
    await settle();

    expect(retired.map((ref) => ref.path)).toEqual(["guide/one"]);
    // Kept, the page would stay "up to date" forever if it ever came back with
    // its original bytes.
    expect((await watermarks()).has(`wiki/${page.id}`)).toBe(false);
  });

  it("removes the old copy after the renamed one is in place (MUL-566)", async () => {
    const page = await seedPage("guide/old");
    await waitFor(() => delivered.wiki.length > 0, "first delivery");
    await settle();
    expect(await deliveredPath(page.id)).toBe("guide/old");

    const res = await request(wikiApp())
      .patch(`/api/companies/${companyId}/team-wiki/agent/pages/${page.id}`)
      .send({ path: "guide/new" });
    expect(res.status).toBe(200);
    await waitFor(() => retired.length > 0, "retirement of the old path");
    await settle();

    // Order is the point: the new copy exists before the old one is taken away,
    // so a crash in between leaves a duplicate rather than nothing at all.
    expect(delivered.wiki.map((snapshot) => snapshot.path)).toEqual(["guide/old", "guide/new"]);
    expect(retired.map((ref) => ref.path)).toEqual(["guide/old"]);
    expect(await deliveredPath(page.id)).toBe("guide/new");
  });

  it("retires an archived page and re-delivers it on unarchive", async () => {
    const page = await seedPage("guide/retired");
    await waitFor(() => delivered.wiki.length > 0, "first delivery");
    await settle();

    expect((await request(wikiApp())
      .post(`/api/companies/${companyId}/team-wiki/agent/pages/${page.id}/archive`)).status).toBe(200);
    await waitFor(() => retired.length > 0, "retirement of the archived page");
    await settle();
    expect(retired.map((ref) => ref.path)).toEqual(["guide/retired"]);
    expect((await watermarks()).has(`wiki/${page.id}`)).toBe(false);

    expect((await request(wikiApp())
      .post(`/api/companies/${companyId}/team-wiki/agent/pages/${page.id}/unarchive`)).status).toBe(200);
    await waitFor(() => delivered.wiki.length > 1, "re-delivery after unarchive");
    await settle();
    expect(await deliveredPath(page.id)).toBe("guide/retired");
  });

  it("leaves the watermark in place while the removal is failing", async () => {
    const page = await seedPage("guide/stuck");
    await waitFor(() => delivered.wiki.length > 0, "first delivery");
    await settle();

    retireIsDown = true;
    expect((await request(wikiApp())
      .post(`/api/companies/${companyId}/team-wiki/agent/pages/${page.id}/archive`)).status).toBe(200);
    await settle();
    // A removal that did not happen must not look like one that did: the
    // watermark still names the file, which is what the retry reads back.
    expect(retired).toHaveLength(0);
    expect(await deliveredPath(page.id)).toBe("guide/stuck");

    retireIsDown = false;
    await waitFor(() => retired.length > 0, "retry after the removal recovers");
    await settle();
    expect((await watermarks()).has(`wiki/${page.id}`)).toBe(false);
  });

  it("retires a page archived while the process was down", async () => {
    const page = await seedPage("guide/offline");
    await waitFor(() => delivered.wiki.length > 0, "first delivery");
    await settle();

    // Archived with no event behind it, exactly as a killed process leaves it.
    await ctx.db
      .update(teamWikiPages)
      .set({ archivedAt: new Date(), archivedByUserId: "board" })
      .where(and(eq(teamWikiPages.id, page.id), eq(teamWikiPages.companyId, companyId)));

    // The live-page sweep cannot see it — only its watermark still can.
    expect(await reconcileTeamDocFanoutOnStartup(ctx.db)).toEqual({ scanned: 1, queued: 1, upToDate: 0 });
    await waitFor(() => retired.length > 0, "retirement queued by the sweep");
    await settle();
    expect(retired.map((ref) => ref.path)).toEqual(["guide/offline"]);
    expect((await watermarks()).has(`wiki/${page.id}`)).toBe(false);
  });
});
