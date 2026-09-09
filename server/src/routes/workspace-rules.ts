import { asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamRuleNotes } from "@paperclipai/db";
import { Router, type Request, type Response } from "express";
import { assertCompanyAccess } from "./authz.js";

/**
 * Team Rules over HTTP: full text, no search and no budget. This is how a
 * terminal gets the rules before it starts work (`paperclip workspace rules`,
 * and the session-start hook).
 *
 * It used to live next to the recall endpoint. Recall was retired in favour of
 * OpenViking (37692caeb, 2026-09-02) and its routes are now gone, so rules
 * stands on its own file rather than riding along with dead code.
 */
export function workspaceRulesRoutes(db: Db): Router {
  const r = Router();

  r.get("/companies/:companyId/workspace/rules", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const notes = await db
      .select({
        id: teamRuleNotes.id,
        title: teamRuleNotes.title,
        body: teamRuleNotes.body,
        updatedAt: teamRuleNotes.updatedAt,
      })
      .from(teamRuleNotes)
      .where(eq(teamRuleNotes.companyId, companyId))
      .orderBy(asc(teamRuleNotes.position));
    res.json(notes);
  });

  return r;
}
