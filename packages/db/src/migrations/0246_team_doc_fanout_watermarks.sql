-- Startup reconciliation for the Team Rules / Team Wiki fan-out (MUL-559).
--
-- The skills fan-out can already recover from a process killed between the DB
-- commit and the projection: the materializer leaves a sidecar in the target
-- directory, so a boot compares change markers and only re-pushes what
-- disagrees. OpenViking has no such marker on our side of the wire, so that
-- same crash silently stranded a saved rule or page — the row was committed,
-- the push never happened, and nothing on the next boot could tell.
--
-- The two ways out were a full re-push of every note and page on every boot,
-- which pays an embedding cost for a case that almost never happens, or a
-- watermark recording what actually went out. This is the watermark.
--
-- `scope` is the fan-out task key rather than an entity id: rules render as one
-- pair of documents built from every note, so the delivery unit is the company,
-- not any single note, and there is no domain row to hang a column on. Wiki
-- pages are per-page and read `wiki/<pageId>`.
--
-- `content_hash` fingerprints the delivered snapshot instead of a version id
-- for the same reason: deleting or reordering notes changes the delivered bytes
-- while every surviving note keeps its own version id.

CREATE TABLE IF NOT EXISTS "team_doc_fanout_watermarks" (
	"company_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"content_hash" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_doc_fanout_watermarks_pkey" PRIMARY KEY ("company_id","scope")
);
--> statement-breakpoint
ALTER TABLE "team_doc_fanout_watermarks" DROP CONSTRAINT IF EXISTS "team_doc_fanout_watermarks_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "team_doc_fanout_watermarks" ADD CONSTRAINT "team_doc_fanout_watermarks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
