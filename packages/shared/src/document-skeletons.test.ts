import { describe, expect, it } from "vitest";
import { DOCUMENT_SKELETONS } from "./document-skeletons.js";
import { parseDecisionLogEntries, REQUIRED_DECISION_LOG_SECTIONS } from "./decision-log-template.js";
import { buildSettledDecisionsSnapshot } from "./settled-decisions.js";

const DECISION_LOG = DOCUMENT_SKELETONS["decision-log"] ?? "";

/**
 * 骨架是开卡播种的正文 (MUL-590)，也是 Team Templates 页和 `document:get` 读不存在
 * 键时给的那一份，所以它的形状本身要有守卫：加格、改字都可能悄悄破掉下游。
 */
describe("decision-log 骨架", () => {
  it("七格齐全且按走法排序：推荐在采纳前，采纳在对审前", () => {
    const order = ["问题", "老板说", "我推荐", "老板采纳", "对审意见", "最终答案", "落点"];
    const positions = order.map((section) => DECISION_LOG.indexOf(`**${section}`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("播出去的账本仍然算零条决策，收卡门禁不会因为播种而放水", () => {
    expect(parseDecisionLogEntries(DECISION_LOG)).toHaveLength(0);
    expect(buildSettledDecisionsSnapshot(DECISION_LOG).settled).toBe(0);
  });

  it("头部写明的硬校验格与程序实际校验的那四格一致", () => {
    for (const section of REQUIRED_DECISION_LOG_SECTIONS) {
      expect(DECISION_LOG).toContain(section);
    }
    expect(DECISION_LOG).toContain("程序当前只硬校验其中四格（老板说 / 我推荐 / 老板采纳 / 落点）");
  });

  it("没送审的写「未审」，这条得写在骨架里，不然「对审意见」会被当成可以删的格", () => {
    expect(DECISION_LOG).toContain("未审");
    expect(DECISION_LOG).toContain("格不能空着");
  });
});

/**
 * 新格插在「老板采纳」和「最终答案」中间，取正文时前一格不能把它吃掉 (MUL-593)。
 */
describe("buildSettledDecisionsSnapshot 遇到七格条目", () => {
  const entry = [
    "# decision-log · MUL-1",
    "",
    "---",
    "",
    "## 1 · 2026-09-09 21:00 · 已定",
    "",
    "**问题**：这一条要定什么",
    "",
    "**老板说**",
    "",
    "> 全采纳",
    "",
    "**我推荐**",
    "",
    "1. 甲",
    "2. 乙",
    "",
    "**老板采纳**：只 ①",
    "",
    "**对审意见**：Codex 异议（对采纳的第 1 条），甲的依据库内零记载",
    "",
    "**最终答案**：改走乙",
    "",
    "**落点**：某文件某节",
  ].join("\n");

  it("问题与最终答案各取各的，不把对审意见并进来", () => {
    const snapshot = buildSettledDecisionsSnapshot(entry);
    expect(snapshot.settled).toBe(1);
    expect(snapshot.rows[0].question).toBe("这一条要定什么");
    expect(snapshot.rows[0].finalAnswer).toBe("改走乙");
    expect(snapshot.rows[0].finalAnswer).not.toContain("Codex");
    expect(snapshot.gapEntryNumbers).toEqual([]);
  });
});
