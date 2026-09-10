-- 参与的 session (MUL-591)
--
-- 卡上原本只有三个单值 session 槽（开卡 / 开工 / 评审），换一个终端接着干
-- 就没有地方记。这张表把「碰过这张卡的 session」攒成列表：判据是写过东西
-- （发进度或评论、写卡内文档、推状态、开决策），纯读不登记。
--
-- 主键就是去重：登记走 upsert，同一个 session 写十次也只有一行，两个
-- session 同时写同一张卡不会互相覆盖 —— 这也是它不做成 issues 上一个
-- JSON 数组列的理由。
--
-- source 区分自动登记与手工补录：手工那条是补机器看不见的参与
-- （只在别处讨论过、没在卡上写过东西的 session），读的人有权知道差别。
--
-- reviewer_session 三列原样保留，存量不迁移。

CREATE TABLE IF NOT EXISTS "issue_participant_sessions" (
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'auto' NOT NULL,
	CONSTRAINT "issue_participant_sessions_pk" PRIMARY KEY ("issue_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "issue_participant_sessions" DROP CONSTRAINT IF EXISTS "issue_participant_sessions_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "issue_participant_sessions" ADD CONSTRAINT "issue_participant_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_participant_sessions_issue_first_seen_idx" ON "issue_participant_sessions" USING btree ("issue_id","first_seen_at");
