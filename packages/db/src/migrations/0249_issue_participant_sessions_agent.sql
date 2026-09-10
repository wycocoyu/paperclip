-- 参与的 session 记住是哪个 agent 写的
--
-- 只存 session id 的那版列表在界面上是一串裸 uuid，认不出 Claude / Codex /
-- ZCode。身份在系统里已经有实体（agents），所以指向它而不是另存一个终端
-- 类型字符串——后者会造出第二套跟 Opened by / Driving 对不上的身份词汇。
--
-- 可空：从界面写入的不是终端 session，本来就没有 agent；存量行也留空。
-- agent 被删就置空而不是连带删掉参与记录——参与是发生过的事实。

ALTER TABLE "issue_participant_sessions" ADD COLUMN IF NOT EXISTS "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_participant_sessions" DROP CONSTRAINT IF EXISTS "issue_participant_sessions_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "issue_participant_sessions" ADD CONSTRAINT "issue_participant_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
