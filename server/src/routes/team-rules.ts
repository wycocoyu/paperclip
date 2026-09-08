import { Router } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamRuleNotes, teamRuleNoteVersions } from "@paperclipai/db";
import { assertCompanyAccess, assertBoardOrAgent } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import {
  publishTeamRuleVersionPublished,
  teamDocFanoutFailures,
  type TeamRuleVersionPublishedEvent,
} from "../services/team-doc-fanout.js";

/**
 * Team Rules: the company's shared rule text. Notes are the only Team
 * Rules-owned storage; skills and the wiki are referenced, never copied.
 *
 * A company keeps exactly one rules document: create is rejected once a note
 * exists, so new rules are merged into the standing text instead of piling up
 * as parallel notes. Every saved edit appends a full snapshot to
 * `team_rule_note_versions`, so the tab can show a revision history and
 * restore an earlier rule text.
 */
export function teamRulesRoutes(db: Db) {
  const router = Router();

  type Actor = ReturnType<typeof getActorInfo>;
  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

  /**
   * Append the next revision for a note. The revision number is derived inside
   * the insert so two concurrent edits cannot both claim the same number — the
   * unique (note_id, revision_number) index would reject the loser anyway, but
   * deriving it here keeps the common path to a single round trip.
   */
  async function appendVersion(tx: Tx, input: {
    companyId: string;
    noteId: string;
    title: string;
    body: string;
    label?: string | null;
    actor: Actor;
  }) {
    const [version] = await tx
      .insert(teamRuleNoteVersions)
      .values({
        companyId: input.companyId,
        noteId: input.noteId,
        revisionNumber: sql<number>`(
          select coalesce(max(${teamRuleNoteVersions.revisionNumber}), 0) + 1
          from ${teamRuleNoteVersions}
          where ${teamRuleNoteVersions.noteId} = ${input.noteId}
        )`,
        title: input.title,
        body: input.body,
        label: input.label ?? null,
        authorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
        authorAgentId: input.actor.actorType === "agent" ? (input.actor.agentId ?? null) : null,
      })
      .returning();
    return version;
  }

  async function requireNote(companyId: string, noteId: string) {
    const [note] = await db
      .select()
      .from(teamRuleNotes)
      .where(and(eq(teamRuleNotes.id, noteId), eq(teamRuleNotes.companyId, companyId)));
    if (!note) throw notFound("Note not found");
    return note;
  }

  // Read-only view of Rules *and* Wiki fan-out deliveries that exhausted their
  // retries. One endpoint because they share one queue; it lives here rather
  // than in a file of its own. In-memory only: the list resets on restart, and
  // nothing rebuilds it — OpenViking has no local marker to reconcile against,
  // so a parked delivery is recovered by the next save or by ov-sync.
  router.get("/companies/:companyId/team-docs/fanout-failures", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ failures: teamDocFanoutFailures(companyId) });
  });

  router.get("/companies/:companyId/team-rules/notes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const notes = await db
      .select()
      .from(teamRuleNotes)
      .where(eq(teamRuleNotes.companyId, companyId))
      .orderBy(asc(teamRuleNotes.position), asc(teamRuleNotes.createdAt));
    // The newest revision's author is the updater — the version chain is the
    // ledger for who touched the text, so the card header reads it from here
    // instead of a duplicated column on the note.
    const withLatestVersion = await Promise.all(
      notes.map(async (note) => {
        const [latestVersion] = await db
          .select({
            revisionNumber: teamRuleNoteVersions.revisionNumber,
            createdAt: teamRuleNoteVersions.createdAt,
            authorUserId: teamRuleNoteVersions.authorUserId,
            authorAgentId: teamRuleNoteVersions.authorAgentId,
          })
          .from(teamRuleNoteVersions)
          .where(
            and(eq(teamRuleNoteVersions.noteId, note.id), eq(teamRuleNoteVersions.companyId, companyId)),
          )
          .orderBy(desc(teamRuleNoteVersions.revisionNumber))
          .limit(1);
        return { ...note, latestVersion: latestVersion ?? null };
      }),
    );
    res.json(withLatestVersion);
  });

  router.post("/companies/:companyId/team-rules/notes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) throw badRequest("title is required");
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    const position = typeof req.body?.position === "number" ? req.body.position : 0;
    const [existing] = await db
      .select({ id: teamRuleNotes.id })
      .from(teamRuleNotes)
      .where(eq(teamRuleNotes.companyId, companyId))
      .limit(1);
    if (existing) {
      throw badRequest("Team Rules keeps a single document — edit the existing note instead of creating another");
    }
    const actor = getActorInfo(req);
    // Collected inside the transaction next to the write it describes, drained
    // only after it commits — a rollback throws past the drain, so a failed
    // save fans out nothing and leaves no version behind either.
    const postCommit: TeamRuleVersionPublishedEvent[] = [];
    const created = await db.transaction(async (tx) => {
      const [note] = await tx
        .insert(teamRuleNotes)
        .values({
          companyId,
          title: title.slice(0, 200),
          body,
          position,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          createdByAgentId: actor.actorType === "agent" ? (actor.agentId ?? null) : null,
        })
        .returning();
      const version = await appendVersion(tx, {
        companyId,
        noteId: note.id,
        title: note.title,
        body: note.body,
        label: "Initial version",
        actor,
      });
      postCommit.push({ companyId, noteId: note.id, versionId: version.id });
      return note;
    });
    for (const event of postCommit) publishTeamRuleVersionPublished(db, event);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team_rules.note_created",
      entityType: "team_rule_note",
      entityId: created.id,
      details: { title: created.title },
    });
    res.status(201).json(created);
  });

  router.patch("/companies/:companyId/team-rules/notes/:noteId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const noteId = req.params.noteId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    const existing = await requireNote(companyId, noteId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof req.body?.title === "string" && req.body.title.trim()) patch.title = req.body.title.trim().slice(0, 200);
    if (typeof req.body?.body === "string") patch.body = req.body.body;
    if (typeof req.body?.position === "number") patch.position = req.body.position;
    const actor = getActorInfo(req);
    const postCommit: TeamRuleVersionPublishedEvent[] = [];
    const updated = await db.transaction(async (tx) => {
      const [note] = await tx
        .update(teamRuleNotes)
        .set(patch)
        .where(and(eq(teamRuleNotes.id, noteId), eq(teamRuleNotes.companyId, companyId)))
        .returning();
      if (!note) throw notFound("Note not found");
      // Reordering is not a rule change, so only text edits earn a revision —
      // otherwise a drag-to-reorder would bury the history in empty versions.
      const textChanged = note.title !== existing.title || note.body !== existing.body;
      if (textChanged) {
        const version = await appendVersion(tx, {
          companyId,
          noteId,
          title: note.title,
          body: note.body,
          label: typeof req.body?.versionLabel === "string"
            ? req.body.versionLabel.trim().slice(0, 200) || null
            : null,
          actor,
        });
        postCommit.push({ companyId, noteId, versionId: version.id });
      }
      return note;
    });
    for (const event of postCommit) publishTeamRuleVersionPublished(db, event);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team_rules.note_updated",
      entityType: "team_rule_note",
      entityId: updated.id,
      details: { title: updated.title },
    });
    res.json(updated);
  });

  router.get("/companies/:companyId/team-rules/notes/:noteId/versions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const noteId = req.params.noteId as string;
    assertCompanyAccess(req, companyId);
    await requireNote(companyId, noteId);
    const versions = await db
      .select()
      .from(teamRuleNoteVersions)
      .where(and(eq(teamRuleNoteVersions.noteId, noteId), eq(teamRuleNoteVersions.companyId, companyId)))
      .orderBy(desc(teamRuleNoteVersions.revisionNumber));
    res.json(versions);
  });

  router.post(
    "/companies/:companyId/team-rules/notes/:noteId/versions/:revisionNumber/restore",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const noteId = req.params.noteId as string;
      const revisionNumber = Number.parseInt(req.params.revisionNumber as string, 10);
      assertCompanyAccess(req, companyId);
      assertBoardOrAgent(req);
      if (!Number.isInteger(revisionNumber)) throw badRequest("revisionNumber must be an integer");
      await requireNote(companyId, noteId);
      const [version] = await db
        .select()
        .from(teamRuleNoteVersions)
        .where(
          and(
            eq(teamRuleNoteVersions.noteId, noteId),
            eq(teamRuleNoteVersions.companyId, companyId),
            eq(teamRuleNoteVersions.revisionNumber, revisionNumber),
          ),
        );
      if (!version) throw notFound("Version not found");
      const actor = getActorInfo(req);
      const postCommit: TeamRuleVersionPublishedEvent[] = [];
      const updated = await db.transaction(async (tx) => {
        const [note] = await tx
          .update(teamRuleNotes)
          .set({ title: version.title, body: version.body, updatedAt: new Date() })
          .where(and(eq(teamRuleNotes.id, noteId), eq(teamRuleNotes.companyId, companyId)))
          .returning();
        if (!note) throw notFound("Note not found");
        // A restore is itself an edit: it lands as a new revision on top rather
        // than rewinding the history, so the rollback stays auditable.
        const appended = await appendVersion(tx, {
          companyId,
          noteId,
          title: note.title,
          body: note.body,
          label: `Restored from v${revisionNumber}`,
          actor,
        });
        postCommit.push({ companyId, noteId, versionId: appended.id });
        return note;
      });
      for (const event of postCommit) publishTeamRuleVersionPublished(db, event);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team_rules.note_restored",
        entityType: "team_rule_note",
        entityId: noteId,
        details: { title: updated.title, restoredFrom: revisionNumber },
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/team-rules/notes/:noteId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const noteId = req.params.noteId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);
    const [deleted] = await db
      .delete(teamRuleNotes)
      .where(and(eq(teamRuleNotes.id, noteId), eq(teamRuleNotes.companyId, companyId)))
      .returning();
    if (!deleted) throw notFound("Note not found");
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team_rules.note_deleted",
      entityType: "team_rule_note",
      entityId: deleted.id,
      details: { title: deleted.title },
    });
    res.json(deleted);
  });

  return router;
}
