import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { parseDecisionLogEntries } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { withIssueDeleteAllowed } from "../services/issue-delete-guard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision-log seed tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * 开卡播种 decision-log (MUL-590)。守两件事：文档确实建出来了，以及它建出来之后
 * 收卡门禁没被放水 —— 骨架里那条示例日期是 `YYYY-MM-DD`，解析不出条目，门禁查的是
 * 「至少一条已定」，所以播种不能让空账本变成过关凭证。
 */
describeEmbeddedPostgres("issue create seeds a decision-log document", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-decision-log-seed-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    // issues 是只可归档的表（MUL-109 的触发器），测试收尾要显式开一次逃生口。
    await db.transaction(async (tx) => {
      await withIssueDeleteAllowed(tx, () => tx.delete(issues));
    });
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function readDocuments(issueId: string) {
    return db
      .select({ key: issueDocuments.key, title: documents.title, body: documents.latestBody })
      .from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(eq(issueDocuments.issueId, issueId));
  }

  async function createIssue(app: express.Express, companyId: string, body: Record<string, unknown>) {
    return request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ description: "> 一句话摘要", ...body })
      .expect(201);
  }

  it("builds the ledger at creation, with the card identifier already filled in", async () => {
    const companyId = await seedCompany();
    const created = await createIssue(createApp(), companyId, { title: "Prepare release" });

    const docs = await readDocuments(created.body.id);
    expect(docs.map((d) => d.key)).toEqual(["decision-log"]);
    expect(docs[0].title).toBe(`decision-log · ${created.body.identifier}`);
    expect(docs[0].body).toContain(`# decision-log · ${created.body.identifier}`);
    expect(docs[0].body).not.toContain("<卡号>");
  });

  it("leaves a first revision behind so the seeded body has history like any other write", async () => {
    const companyId = await seedCompany();
    const created = await createIssue(createApp(), companyId, { title: "Prepare release" });

    const [doc] = await db
      .select({ id: documents.id, latestRevisionId: documents.latestRevisionId })
      .from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(and(eq(issueDocuments.issueId, created.body.id), eq(issueDocuments.key, "decision-log")));
    const revisions = await db
      .select({ id: documentRevisions.id, number: documentRevisions.revisionNumber })
      .from(documentRevisions)
      .where(eq(documentRevisions.documentId, doc.id));

    expect(revisions).toHaveLength(1);
    expect(revisions[0].number).toBe(1);
    expect(doc.latestRevisionId).toBe(revisions[0].id);
  });

  it("seeds nothing that a close gate reads for existence", async () => {
    const companyId = await seedCompany();
    const created = await createIssue(createApp(), companyId, { title: "Prepare release" });

    const keys = (await readDocuments(created.body.id)).map((d) => d.key);
    expect(keys).not.toContain("requirements");
    expect(keys).not.toContain("tech-proposal");
  });

  it("seeds a ledger that still counts as zero decisions", async () => {
    const companyId = await seedCompany();
    const created = await createIssue(createApp(), companyId, { title: "Prepare release" });

    const [doc] = await readDocuments(created.body.id);
    expect(parseDecisionLogEntries(doc.body ?? "")).toHaveLength(0);
  });

  it("does not seed a second ledger when the create is deduplicated", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const first = await createIssue(app, companyId, {
      title: "Prepare release",
      idempotencyKey: "run-1:prepare-release",
    });
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        description: "> 一句话摘要",
        title: "Different retry payload",
        idempotencyKey: "run-1:prepare-release",
        allowDuplicate: true,
      })
      .expect(200);

    expect(await readDocuments(first.body.id)).toHaveLength(1);
  });
});
