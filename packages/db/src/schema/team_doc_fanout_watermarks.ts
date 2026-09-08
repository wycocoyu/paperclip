import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * What the Team Rules / Team Wiki fan-out last delivered successfully.
 *
 * Skills can answer "did the projection actually happen" by reading the sidecar
 * the materializer left in the target directory. OpenViking is a remote store
 * with no such marker, so without this table a process killed between the DB
 * commit and the push leaves nothing to reconcile from, and a startup sweep
 * would have to re-push every note and page on every boot (MUL-559 acceptance
 * criterion 7).
 *
 * `scope` is the fan-out task key: `rules` for the company-wide rules pair,
 * `wiki/<pageId>` for one page. Rules render as one document out of every note,
 * so there is no single domain row to hang a column on — the watermark belongs
 * to the delivery unit, not to a note.
 *
 * `contentHash` fingerprints the snapshot that was delivered rather than a
 * version id, because the rules snapshot has no single version: deleting or
 * reordering notes changes the delivered bytes while every surviving note keeps
 * its own version id.
 *
 * A row survives the page it names being deleted. Nothing reads a scope whose
 * page is gone, and retiring the OpenViking file left behind is MUL-566's job,
 * not this table's.
 */
export const teamDocFanoutWatermarks = pgTable(
  "team_doc_fanout_watermarks",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    contentHash: text("content_hash").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The startup sweep reads one company's whole set; the primary key's
    // leading column already answers that, so there is no second index.
    pk: primaryKey({ columns: [table.companyId, table.scope] }),
  }),
);
