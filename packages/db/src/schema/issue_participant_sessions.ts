import { pgTable, uuid, text, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

export const issueParticipantSessions = pgTable(
  "issue_participant_sessions",
  {
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
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
