import { Router } from "express";
import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { TEAM_WIKI_SPACES, teamWikiPages, teamWikiPageVersions } from "@paperclipai/db";
import { assertCompanyAccess, assertBoardOrAgent } from "./authz.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import {
  publishTeamWikiVersionPublished,
  type TeamWikiVersionPublishedEvent,
} from "../services/team-doc-fanout.js";

/**
 * Team Wiki: durable team knowledge in two spaces — `paperclip` (written for
 * people) and `agent` (written for agents to act on). Same storage, different
 * reader, so the space is a path segment rather than a separate surface.
 *
 * Every saved edit appends a full snapshot to `team_wiki_page_versions`, so the
 * tab can show a revision history and restore an earlier page — the same shape
 * the Team Rules routes use.
 */
export function teamWikiRoutes(db: Db) {
  const router = Router();

  type Actor = ReturnType<typeof getActorInfo>;
  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

  function requireSpace(raw: string): (typeof TEAM_WIKI_SPACES)[number] {
    const space = TEAM_WIKI_SPACES.find((candidate) => candidate === raw);
    if (!space) throw badRequest(`space must be one of ${TEAM_WIKI_SPACES.join(", ")}`);
    return space;
  }

  /**
   * Normalize a page path to the one canonical form the unique index compares:
   * no leading or trailing slash, no empty or relative segments. Without this a
   * page could be created twice under `a/b` and `/a/b/`.
   */
  function normalizePath(raw: unknown): string {
    if (typeof raw !== "string") throw badRequest("path is required");
    const segments = raw
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) throw badRequest("path is required");
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw badRequest("path segments must not be . or ..");
    }
    const path = segments.join("/");
    if (path.length > 400) throw badRequest("path is too long");
    return path;
  }

  /**
   * Append the next revision. The revision number is derived inside the insert
   * so two concurrent edits cannot both claim the same number.
   */
  async function appendVersion(tx: Tx, input: {
    companyId: string;
    pageId: string;
    path: string;
    title: string;
    body: string;
    label?: string | null;
    actor: Actor;
  }) {
    const [version] = await tx
      .insert(teamWikiPageVersions)
      .values({
        companyId: input.companyId,
        pageId: input.pageId,
        revisionNumber: sql<number>`(
          select coalesce(max(${teamWikiPageVersions.revisionNumber}), 0) + 1
          from ${teamWikiPageVersions}
          where ${teamWikiPageVersions.pageId} = ${input.pageId}
        )`,
        path: input.path,
        title: input.title,
        body: input.body,
        label: input.label ?? null,
        authorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
        authorAgentId: input.actor.actorType === "agent" ? (input.actor.agentId ?? null) : null,
      })
      .returning();
    return version;
  }

  /**
   * `(company, space, path)` is unique, so a second page at the same location
   * is a caller mistake, not a server fault — say so with the path that
   * collided instead of letting the driver error surface as a 500.
   */
  function rethrowPathConflict(error: unknown, space: string, path: string): never {
    // Drizzle wraps the driver error, so the constraint name can sit on the
    // wrapper's message, on a `cause`, or on a postgres-specific field —
    // walking the chain avoids matching only whichever shape we saw first.
    const seen = new Set<unknown>();
    for (let current: unknown = error; current && !seen.has(current); current = (current as { cause?: unknown }).cause) {
      seen.add(current);
      const parts = [
        (current as { message?: unknown }).message,
        (current as { constraint_name?: unknown }).constraint_name,
        (current as { detail?: unknown }).detail,
      ];
      if (parts.some((part) => typeof part === "string" && part.includes("team_wiki_pages_company_space_path_uq"))) {
        throw conflict(`A page already exists at ${space}/${path}`, { code: "team_wiki_path_taken", space, path });
      }
    }
    throw error;
  }

  async function requirePage(companyId: string, pageId: string) {
    const [page] = await db
      .select()
      .from(teamWikiPages)
      .where(and(eq(teamWikiPages.id, pageId), eq(teamWikiPages.companyId, companyId)));
    if (!page) throw notFound("Page not found");
    return page;
  }

  /**
   * List one space, newest edit first. `q` filters on title and body via the
   * trgm indexes — deliberately a substring match rather than ranked full-text:
   * a team wiki is small enough that finding the page beats ranking pages.
   */
  router.get("/companies/:companyId/team-wiki/:space/pages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const space = requireSpace(req.params.space as string);
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const search = query
      ? or(
        ilike(teamWikiPages.title, `%${query}%`),
        ilike(teamWikiPages.body, `%${query}%`),
        ilike(teamWikiPages.path, `%${query}%`),
      )
      : undefined;
    // 归档 (MUL-455): retired pages drop out of the default listing, because a
    // stale page sitting next to a current one is the failure this exists to
    // prevent. `?archived=true` is how the archive view asks for them back.
    const archivedOnly = req.query.archived === "true";
    const pages = await db
      .select()
      .from(teamWikiPages)
      .where(and(
        eq(teamWikiPages.companyId, companyId),
        eq(teamWikiPages.space, space),
        archivedOnly ? isNotNull(teamWikiPages.archivedAt) : isNull(teamWikiPages.archivedAt),
        search,
      ))
      .orderBy(asc(teamWikiPages.path));
    res.json(pages);
  });

  /**
   * Every archived page in the company, across spaces (MUL-455).
   *
   * The archive is one shelf rather than one per space: someone looking for a
   * retired page remembers what it said, not which space it lived in. The
   * `space` field rides along on each row so the view can still label them.
   */
  router.get("/companies/:companyId/team-wiki-archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const search = query
      ? or(
        ilike(teamWikiPages.title, `%${query}%`),
        ilike(teamWikiPages.body, `%${query}%`),
        ilike(teamWikiPages.path, `%${query}%`),
      )
      : undefined;
    const pages = await db
      .select()
      .from(teamWikiPages)
      .where(and(eq(teamWikiPages.companyId, companyId), isNotNull(teamWikiPages.archivedAt), search))
      .orderBy(desc(teamWikiPages.archivedAt));
    res.json(pages);
  });

  router.post("/companies/:companyId/team-wiki/:space/pages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    const space = requireSpace(req.params.space as string);
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) throw badRequest("title is required");
    const path = normalizePath(req.body?.path ?? title);
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    const actor = getActorInfo(req);
    // Collected inside the transaction next to the write it describes, drained
    // only after it commits — a rollback throws past the drain, so a failed
    // save fans out nothing and leaves no version behind either.
    const postCommit: TeamWikiVersionPublishedEvent[] = [];
    const created = await db.transaction(async (tx) => {
      const [page] = await tx
        .insert(teamWikiPages)
        .values({
          companyId,
          space,
          path,
          title: title.slice(0, 200),
          body,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          createdByAgentId: actor.actorType === "agent" ? (actor.agentId ?? null) : null,
        })
        .returning()
        .catch((error: unknown) => rethrowPathConflict(error, space, path));
      const version = await appendVersion(tx, {
        companyId,
        pageId: page.id,
        path: page.path,
        title: page.title,
        body: page.body,
        label: "Initial version",
        actor,
      });
      postCommit.push({ companyId, pageId: page.id, versionId: version.id });
      return page;
    });
    for (const event of postCommit) publishTeamWikiVersionPublished(db, event);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team_wiki.page_created",
      entityType: "team_wiki_page",
      entityId: created.id,
      details: { space, path: created.path, title: created.title },
    });
    res.status(201).json(created);
  });

  router.patch("/companies/:companyId/team-wiki/:space/pages/:pageId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const pageId = req.params.pageId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    requireSpace(req.params.space as string);
    const existing = await requirePage(companyId, pageId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof req.body?.title === "string" && req.body.title.trim()) patch.title = req.body.title.trim().slice(0, 200);
    if (typeof req.body?.body === "string") patch.body = req.body.body;
    if (req.body?.path !== undefined) patch.path = normalizePath(req.body.path);
    const actor = getActorInfo(req);
    const postCommit: TeamWikiVersionPublishedEvent[] = [];
    const updated = await db.transaction(async (tx) => {
      const [page] = await tx
        .update(teamWikiPages)
        .set(patch)
        .where(and(eq(teamWikiPages.id, pageId), eq(teamWikiPages.companyId, companyId)))
        .returning()
        .catch((error: unknown) => rethrowPathConflict(error, existing.space, String(patch.path ?? existing.path)));
      if (!page) throw notFound("Page not found");
      const changed = page.title !== existing.title
        || page.body !== existing.body
        || page.path !== existing.path;
      if (changed) {
        const version = await appendVersion(tx, {
          companyId,
          pageId,
          path: page.path,
          title: page.title,
          body: page.body,
          label: typeof req.body?.versionLabel === "string"
            ? req.body.versionLabel.trim().slice(0, 200) || null
            : null,
          actor,
        });
        postCommit.push({ companyId, pageId, versionId: version.id });
      }
      return page;
    });
    for (const event of postCommit) publishTeamWikiVersionPublished(db, event);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team_wiki.page_updated",
      entityType: "team_wiki_page",
      entityId: updated.id,
      details: { space: updated.space, path: updated.path, title: updated.title },
    });
    res.json(updated);
  });

  router.get("/companies/:companyId/team-wiki/:space/pages/:pageId/versions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const pageId = req.params.pageId as string;
    assertCompanyAccess(req, companyId);
    requireSpace(req.params.space as string);
    await requirePage(companyId, pageId);
    const versions = await db
      .select()
      .from(teamWikiPageVersions)
      .where(and(eq(teamWikiPageVersions.pageId, pageId), eq(teamWikiPageVersions.companyId, companyId)))
      .orderBy(desc(teamWikiPageVersions.revisionNumber));
    res.json(versions);
  });

  router.post(
    "/companies/:companyId/team-wiki/:space/pages/:pageId/versions/:revisionNumber/restore",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const pageId = req.params.pageId as string;
      const revisionNumber = Number.parseInt(req.params.revisionNumber as string, 10);
      assertCompanyAccess(req, companyId);
      assertBoardOrAgent(req);
      requireSpace(req.params.space as string);
      if (!Number.isInteger(revisionNumber)) throw badRequest("revisionNumber must be an integer");
      await requirePage(companyId, pageId);
      const [version] = await db
        .select()
        .from(teamWikiPageVersions)
        .where(
          and(
            eq(teamWikiPageVersions.pageId, pageId),
            eq(teamWikiPageVersions.companyId, companyId),
            eq(teamWikiPageVersions.revisionNumber, revisionNumber),
          ),
        );
      if (!version) throw notFound("Version not found");
      const actor = getActorInfo(req);
      const postCommit: TeamWikiVersionPublishedEvent[] = [];
      const updated = await db.transaction(async (tx) => {
        const [page] = await tx
          .update(teamWikiPages)
          .set({ path: version.path, title: version.title, body: version.body, updatedAt: new Date() })
          .where(and(eq(teamWikiPages.id, pageId), eq(teamWikiPages.companyId, companyId)))
          .returning();
        if (!page) throw notFound("Page not found");
        // A restore is itself an edit: it lands as a new revision on top rather
        // than rewinding history, so the rollback stays auditable.
        const appended = await appendVersion(tx, {
          companyId,
          pageId,
          path: page.path,
          title: page.title,
          body: page.body,
          label: `Restored from v${revisionNumber}`,
          actor,
        });
        postCommit.push({ companyId, pageId, versionId: appended.id });
        return page;
      });
      for (const event of postCommit) publishTeamWikiVersionPublished(db, event);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team_wiki.page_restored",
        entityType: "team_wiki_page",
        entityId: pageId,
        details: { space: updated.space, path: updated.path, restoredFrom: revisionNumber },
      });
      res.json(updated);
    },
  );

  /**
   * Archive or restore a page (MUL-455).
   *
   * One handler for both directions because they are the same write with the
   * columns set or cleared, and splitting them duplicated the lookup, the
   * actor resolution and the audit line for no gain.
   *
   * Reversible by construction: nothing is deleted, no revision is appended,
   * and restoring clears exactly the three columns archiving set. That is the
   * property that made it safe to retire every page at once.
   */
  async function setArchived(req: Parameters<Parameters<typeof router.post>[1]>[0], res: Parameters<Parameters<typeof router.post>[1]>[1], archived: boolean) {
    const companyId = req.params.companyId as string;
    const pageId = req.params.pageId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    requireSpace(req.params.space as string);
    const actor = getActorInfo(req);
    // The check constraint accepts exactly one filled actor slot, so an actor
    // with neither id would be rejected by the database rather than silently
    // stored as archived-by-nobody.
    const [updated] = await db
      .update(teamWikiPages)
      .set(archived
        ? {
          archivedAt: new Date(),
          archivedByUserId: actor.actorType === "user" ? actor.actorId : null,
          archivedByAgentId: actor.actorType === "user" ? null : actor.agentId,
          updatedAt: new Date(),
        }
        : { archivedAt: null, archivedByUserId: null, archivedByAgentId: null, updatedAt: new Date() })
      .where(and(eq(teamWikiPages.id, pageId), eq(teamWikiPages.companyId, companyId)))
      .returning();
    if (!updated) throw notFound("Page not found");
    // Archiving hides the page here but not downstream: without this the
    // OpenViking copy keeps answering recalls for a page the team retired
    // (MUL-566). Unarchiving publishes for the same reason, in reverse.
    publishTeamWikiVersionPublished(db, { companyId, pageId });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: archived ? "team_wiki.page_archived" : "team_wiki.page_restored",
      entityType: "team_wiki_page",
      entityId: updated.id,
      details: { space: updated.space, path: updated.path, title: updated.title },
    });
    res.json(updated);
  }

  router.post("/companies/:companyId/team-wiki/:space/pages/:pageId/archive", async (req, res) => {
    await setArchived(req, res, true);
  });

  router.post("/companies/:companyId/team-wiki/:space/pages/:pageId/unarchive", async (req, res) => {
    await setArchived(req, res, false);
  });

  router.delete("/companies/:companyId/team-wiki/:space/pages/:pageId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const pageId = req.params.pageId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    requireSpace(req.params.space as string);
    const [deleted] = await db
      .delete(teamWikiPages)
      .where(and(eq(teamWikiPages.id, pageId), eq(teamWikiPages.companyId, companyId)))
      .returning();
    if (!deleted) throw notFound("Page not found");
    publishTeamWikiVersionPublished(db, { companyId, pageId });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team_wiki.page_deleted",
      entityType: "team_wiki_page",
      entityId: deleted.id,
      details: { space: deleted.space, path: deleted.path, title: deleted.title },
    });
    res.json(deleted);
  });

  return router;
}
