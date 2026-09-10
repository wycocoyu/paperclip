import {
  REQUIRED_DECISION_LOG_SECTIONS,
  isSettledDecisionLogEntry,
  parseDecisionLogEntries,
} from "./decision-log-template.js";

/**
 * settled-decisions 快照：把 decision-log 这本流水账机械压成「问题 → 最终答案」一张表，
 * 供老板一眼看完当前有效的结论。全量重新生成，不局部改。
 *
 * 判据不自己造：条目切分与「哪些算已定」全部走 decision-log-template，
 * 与 CLI 的 decisions:pull、服务端门禁用的是同一份。
 *
 * 缺格降级而不是整批失败：全库 131 条当前有效条目里 122 条缺「问题」或「最终答案」，
 * 硬校验会让这条命令对现存的卡一张都跑不出来。
 */

export type SettledDecisionRow = {
  /** 表格自己的 1..M 连续序号 */
  index: number;
  /** decision-log 里的条目号 */
  entryNumber: number;
  question: string | null;
  finalAnswer: string | null;
};

export type SettledDecisionsSnapshot = {
  /** N：流水账条目总数 */
  total: number;
  /** M：当前已定条目数，等于 rows.length */
  settled: number;
  /** X：「问题」与「最终答案」都提取到的条目数 */
  complete: number;
  /** 缺「问题」或「最终答案」的条目号 */
  gapEntryNumbers: number[];
  rows: SettledDecisionRow[];
};

/**
 * 划格边界要认全七个格名，不只硬校验那四个，否则正文里的加粗句会被当成下一格。
 * 新加的格必须登记进来 (MUL-593)，否则排在它前面那一格会一路吃到再下一个已知格名，
 * 把新格的内容并进自己的正文里。
 */
const ALL_DECISION_LOG_SECTIONS = ["问题", "对审意见", "最终答案", ...REQUIRED_DECISION_LOG_SECTIONS];

/**
 * 先提完整加粗标签再比，不能只比前缀：`**问题不在内容，在触发时机。**` 是正文不是标题，
 * 前缀匹配会把它当成「问题」格而截断上一格。
 * 只接受两种标签：恰好等于格名，或格名后跟一个括号补充（`**我推荐（即本次裁决）**` 是真实写法）。
 * 两种正文写法都认：`**问题**` 后另起段落，和 `**问题**：正文` 跟在冒号后。
 */
function isSectionHeading(line: string, section: string): boolean {
  const matched = /^\*\*([^*]+)\*\*/.exec(line);
  if (!matched) return false;
  const label = matched[1].trim();
  if (label === section) return true;
  return new RegExp(`^${section}[（(][^（）()]*[）)]$`).test(label);
}

function extractSection(entryBody: string, section: string): string | null {
  const lines = entryBody.split("\n");
  const start = lines.findIndex((line) => isSectionHeading(line, section));
  if (start < 0) return null;
  const collected: string[] = [];
  const inline = lines[start].replace(/^\*\*[^*]*\*\*/, "").replace(/^\s*[:：]\s*/, "");
  if (inline.trim()) collected.push(inline);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (ALL_DECISION_LOG_SECTIONS.some((name) => isSectionHeading(lines[i], name))) break;
    collected.push(lines[i]);
  }
  const text = collected.join("\n").trim();
  return text === "" ? null : text;
}

export function buildSettledDecisionsSnapshot(markdown: string): SettledDecisionsSnapshot {
  const all = parseDecisionLogEntries(markdown);
  const settled = all.filter(isSettledDecisionLogEntry);
  const rows = settled.map((entry, i) => ({
    index: i + 1,
    entryNumber: entry.number,
    question: extractSection(entry.body, "问题"),
    finalAnswer: extractSection(entry.body, "最终答案"),
  }));
  const gapEntryNumbers = rows.filter((r) => !r.question || !r.finalAnswer).map((r) => r.entryNumber);
  return {
    total: all.length,
    settled: rows.length,
    complete: rows.length - gapEntryNumbers.length,
    gapEntryNumbers,
    rows,
  };
}

/** 单元格里的 `|` 会把表格切散，换行会把行截断，两者都在这里压平。 */
function cell(text: string | null, entryNumber: number): string {
  if (!text) return `未记录，见 decision-log 第 ${entryNumber} 条`;
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

export function renderSettledDecisionsDocument(input: {
  issueId: string;
  sourceRevisionId: string | null;
  snapshot: SettledDecisionsSnapshot;
}): string {
  const { issueId, sourceRevisionId, snapshot } = input;
  const lines = [
    `# settled-decisions · ${issueId}`,
    "",
    "> 从 decision-log 全量重新生成，不局部手改。改答案请改 decision-log 再重新生成。",
    ">",
    `> 来源 decision-log revision：${sourceRevisionId ?? "未知"}`,
    `> 流水账条目总数 N：${snapshot.total}　当前已定 M：${snapshot.settled}　结构化完整 X/M：${snapshot.complete}/${snapshot.settled}`,
  ];
  if (snapshot.gapEntryNumbers.length > 0) {
    lines.push(
      `> 缺口条目：第 ${snapshot.gapEntryNumbers.join(", ")} 条（这些条目缺「问题」或「最终答案」，需读 decision-log 原文）`,
    );
  }
  lines.push("", "| 序号 | 问题 | 最终答案 | 来源 decision-log |", "|---|---|---|---|");
  for (const row of snapshot.rows) {
    lines.push(
      `| ${row.index} | ${cell(row.question, row.entryNumber)} | ${cell(row.finalAnswer, row.entryNumber)} | 第 ${row.entryNumber} 条 |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
