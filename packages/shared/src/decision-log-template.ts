/**
 * decision-log 条目切分 (MUL-465)：开决策卡前的第一步是「拉」——把这一段所有
 * 已定的条目原样列出来。它是机械的：认 `## <编号> · <日期时间> · <状态>` 这行标题，
 * 日期段为 `YYYY-MM-DD`，时分 `HH:MM` 可选（MUL-465：新条目带时分，存量纯日期
 * 33 条仍须认；日期段含空格，故不能再用 `\S+` 匹配），
 * 状态段里带「已定」就收，带「已被」就不收（「已被第 N 条推翻」也含「已定」二字
 * 之外的形，故先判推翻再判已定）。
 *
 * 纯正则、不调模型：这一步不需要理解语义，需要的是不漏。人工翻文档会跳读——
 * MUL-463 那份 40 条时就没逐条看过。
 *
 * 判据住在 shared，因为 CLI 的 decisions:pull、服务端收卡门禁
 * (issue-prerequisites) 和 document:put 的模板校验读的必须是同一个标题形状。
 */
export type DecisionLogEntry = {
  number: number;
  date: string;
  status: string;
  /** 标题行本身，原样 */
  heading: string;
  /** 该条目全文（含标题行），到下一个条目标题或文末为止，尾部空行已裁 */
  body: string;
};

/**
 * 日期段认到下一个间隔点为止 (MUL-590)：原来是 `YYYY-MM-DD` 加可选 `HH:MM`，时分后面
 * 一旦多出时区就整行不匹配（`## 1 · 2026-09-07 05:10 PDT · 已定`），那一条对
 * decisions:pull、收卡门禁和四格校验一起隐形，写的人和读的人都收不到提示 —— MUL-563
 * 收卡时 15 条里 7 条是这么丢的，MUL-561 三条全丢。改成「以 ISO 日期开头、吃到下一个
 * `·` 为止」，时区、秒、偏移量一并认，不必逐种枚举；间隔点本身不在字符类里，所以状态段
 * 照样切得开。
 */
const DECISION_LOG_HEADING = /^##\s+(\d+)\s+·\s+(\d{4}-\d{2}-\d{2}[^·]*?)\s+·\s+(.+)$/;

/** 长得像条目标题的行：`## <编号> ·` 开头。用来找出没被上面认出来的那些。 */
const DECISION_LOG_HEADING_SHAPE = /^##\s+\d+\s+·/;

export function parseDecisionLogEntries(markdown: string): DecisionLogEntry[] {
  const lines = markdown.split("\n");
  const starts: Array<{ index: number; number: number; date: string; status: string; heading: string }> = [];
  lines.forEach((line, index) => {
    const m = DECISION_LOG_HEADING.exec(line);
    if (m) starts.push({ index, number: Number(m[1]), date: m[2], status: m[3].trim(), heading: line });
  });
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : lines.length;
    // 条目之间常有 `---` 分隔，它属于版式不属于任何一条，裁掉尾部的分隔与空行。
    let slice = lines.slice(start.index, end);
    while (slice.length > 0) {
      const last = slice[slice.length - 1].trim();
      if (last === "" || last === "---") slice = slice.slice(0, -1);
      else break;
    }
    return { number: start.number, date: start.date, status: start.status, heading: start.heading, body: slice.join("\n") };
  });
}

/** 「已定」判定：被推翻的条目状态里同样出现「已定」，故先排除推翻。 */
export function isSettledDecisionLogEntry(entry: DecisionLogEntry): boolean {
  if (entry.status.includes("已被")) return false;
  return entry.status.includes("已定");
}

/**
 * 四格模板 (MUL-498, 老板令 2026-09-02)：全库 122 条里 114 条本来就四格齐全，
 * 全要不增负担，还省掉「我推荐非空时老板采纳必填」那个条件判断。
 */
export const REQUIRED_DECISION_LOG_SECTIONS = ["老板说", "我推荐", "老板采纳", "落点"] as const;

/**
 * 行首前缀匹配，不能用等值：`**我推荐（即本次裁决）**` 是真实写法，等值匹配会把
 * 它误判成缺格。形状照抄 missingDecisionBodySections。
 */
function missingSectionsInEntry(entryBody: string): string[] {
  return REQUIRED_DECISION_LOG_SECTIONS.filter(
    (section) => !new RegExp(`^\\*\\*${section}`, "m").test(entryBody),
  );
}

/** 标题行带状态，推翻回写只翻状态不动正文，故「有没有改过」比对时剔掉它。 */
function bodyWithoutHeading(entry: DecisionLogEntry): string {
  return entry.body.slice(entry.heading.length).trim();
}

/**
 * 只查本次新增或改动的条目：prev 里没有这个编号、或有但正文不同，才查四格。
 * 继承来的不合规条目不挡住后来人——你只为自己写的负责。`prevBody` 传空串退化
 * 成全查，第一次建文档就是这个情况。把已定翻成「已被第 N 条推翻」不算改动，
 * 否则存量缺格条目会挡住推翻回写。
 */
export function missingDecisionLogSections(
  prevBody: string,
  nextBody: string,
): Array<{ number: number; missing: string[] }> {
  const prev = new Map(parseDecisionLogEntries(prevBody).map((e) => [e.number, bodyWithoutHeading(e)]));
  const out: Array<{ number: number; missing: string[] }> = [];
  for (const entry of parseDecisionLogEntries(nextBody)) {
    if (prev.get(entry.number) === bodyWithoutHeading(entry)) continue;
    const missing = missingSectionsInEntry(entry.body);
    if (missing.length > 0) out.push({ number: entry.number, missing });
  }
  return out;
}

/**
 * 认不出的标题行 (MUL-590)：形状对、解析不出来的那些。它们不会报错，只会被并进上一条
 * 的正文里，于是那一条决策对所有下游一起消失。放宽日期段之后剩下的是别的写歪法（日期
 * 不补零、间隔点写成别的符号），机器判得出来，所以在写入那一刻拦掉，不留到事后对账。
 *
 * 只查本次新增的行，形状照抄 {@link missingDecisionLogSections}：继承来的歪标题不挡住
 * 后来人，你只为自己写的负责。
 */
export function unparsedDecisionLogHeadings(prevBody: string, nextBody: string): string[] {
  const suspect = (body: string) =>
    body.split("\n").filter((line) => DECISION_LOG_HEADING_SHAPE.test(line) && !DECISION_LOG_HEADING.test(line));
  const inherited = new Set(suspect(prevBody));
  return suspect(nextBody).filter((line) => !inherited.has(line));
}

/**
 * 拒绝本身就是送达：错误里带条目号、缺哪格、以及占位写法，看到错误的人不需要
 * 再去查模板。CLI 抛它、服务端 422 也用它，文案一份。
 */
export function decisionLogTemplateError(prevBody: string, nextBody: string): string | null {
  // 标题先判：标题认不出，它下面那几格会被算进上一条，缺格报出来的条目号是错的。
  const unparsed = unparsedDecisionLogHeadings(prevBody, nextBody);
  if (unparsed.length > 0) {
    return [
      `decision-log 标题行认不出：${unparsed.map((line) => `「${line.trim()}」`).join("，")}`,
      "—— 标题形状固定：`## <编号> · <日期> · <状态>`，三段之间用「 · 」隔开，日期以 YYYY-MM-DD 开头（后面可带时分与时区）。",
      "认不出的标题不会报错也不会消失，它会被并进上一条的正文，那一条决策对 decisions:pull、收卡门禁和四格校验一起隐形。",
    ].join("\n");
  }
  const offenders = missingDecisionLogSections(prevBody, nextBody);
  if (offenders.length === 0) return null;
  const detail = offenders
    .map((o) => `第 ${o.number} 条缺${o.missing.map((s) => `「${s}」`).join("")}`)
    .join("，");
  return [
    `decision-log 缺格：${detail}`,
    "—— 每条七格，顺序固定：问题 / 老板说（原话照抄）/ 我推荐 / 老板采纳 / 对审意见 / 最终答案 / 落点，一条只回答一个问题。",
    "—— 程序当前硬校验其中四格：老板说 / 我推荐 / 老板采纳 / 落点；「问题」「最终答案」「对审意见」同样要写，没被程序拦住不等于可以省。没交给另一个终端模型审过的，「对审意见」写「未审」。",
    "老板没直接发话的条目，「老板说」写明「本条老板未直接发话，由我主动记录」。",
  ].join("\n");
}
