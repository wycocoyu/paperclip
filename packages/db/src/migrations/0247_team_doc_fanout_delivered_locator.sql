-- Where the Team Wiki fan-out last put a page's OpenViking file (MUL-566).
--
-- A page whose path changes, or that gets archived or deleted, leaves its old
-- file on OpenViking. That is not harmless residue: OpenViking recall has no
-- exclude filter — `ov find --tags` only narrows to matching tags, so a
-- tombstone or an `archived/` prefix still answers queries — and a retired
-- statement that gets recalled is worse than one that cannot be found, because
-- nothing tells the reader to keep looking. The only retirement OpenViking
-- honours is `ov rm`.
--
-- Removing the old file needs its old path, and by the time the fan-out runs
-- the row holds only the new one. The page's version history is the wrong
-- source: the queue coalesces a burst of saves into one delivery, so a page
-- renamed a -> b -> c would leave `a` behind while history points at `b`. What
-- is actually needed is what the last successful push addressed, which is what
-- this watermark already records — so the locator goes here, next to the
-- content hash that was delivered with it.
--
-- Nullable because the rules pair has no page locator: its two URIs are fixed
-- constants and can never orphan.

ALTER TABLE "team_doc_fanout_watermarks"
  ADD COLUMN IF NOT EXISTS "delivered_space" text,
  ADD COLUMN IF NOT EXISTS "delivered_path" text;

-- Rows written before this column existed still name a real file on
-- OpenViking, and the only path it could have been written under is the one
-- the page holds now — a rename between that push and this migration would
-- have left an orphan either way, and leaving these NULL would additionally
-- lose the file the next archive is supposed to remove.
UPDATE "team_doc_fanout_watermarks" AS w
SET "delivered_space" = p."space", "delivered_path" = p."path"
FROM "team_wiki_pages" AS p
WHERE w."delivered_path" IS NULL
  AND w."company_id" = p."company_id"
  AND w."scope" = 'wiki/' || p."id"::text;
