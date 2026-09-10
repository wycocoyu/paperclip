import { pgTable, uuid, text, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export const issueParticipantSessions = pgTable(
  "issue_participant_sessions",
  {
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    // 认得出是谁写的：id 是裸 uuid，光看它分不出 Claude / Codex / ZCode。
    // 可空——界面写入没有终端 agent，手工补录也允许不指认。
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").notNull().default("auto"),
  },
  (table) => ({
    // 去重就是主键本身：登记走 upsert，重复写入退化成空操作，
    // 两个 session 同时写同一张卡也不会互相覆盖。
    pk: primaryKey({ columns: [table.issueId, table.sessionId], name: "issue_participant_sessions_pk" }),
    issueFirstSeenIdx: index("issue_participant_sessions_issue_first_seen_idx").on(table.issueId, table.firstSeenAt),
  }),
);
