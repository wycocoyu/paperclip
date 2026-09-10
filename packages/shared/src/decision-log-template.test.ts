import { describe, expect, it } from "vitest";
import {
  decisionLogTemplateError,
  missingDecisionLogSections,
  parseDecisionLogEntries,
  unparsedDecisionLogHeadings,
} from "./decision-log-template.js";

const HEADER = "# decision-log · MUL-1\n\n> 用 v1 模板记录。\n\n---\n";

function entry(number: number, sections: string[], extra = ""): string {
  const lines = [`## ${number} · 2026-09-02 07:00 · 已定`, ""];
  for (const s of sections) lines.push(`**${s}**`, "", "内容", "");
  if (extra) lines.push(extra, "");
  return `${lines.join("\n")}---\n`;
}

const FULL = ["老板说", "我推荐", "老板采纳", "落点"];

describe("missingDecisionLogSections", () => {
  it("reports a newly added entry that is missing sections", () => {
    const prev = HEADER + entry(1, FULL);
    const next = prev + entry(2, ["老板说", "我推荐"]);
    expect(missingDecisionLogSections(prev, next)).toEqual([
      { number: 2, missing: ["老板采纳", "落点"] },
    ]);
  });

  it("lets an inherited bad entry through when this write did not touch it", () => {
    const prev = HEADER + entry(1, ["内容"]);
    const next = prev + entry(2, FULL);
    expect(missingDecisionLogSections(prev, next)).toEqual([]);
  });

  it("checks an inherited entry once its text changes", () => {
    const prev = HEADER + entry(1, ["内容"]);
    const next = HEADER + entry(1, ["内容"], "**推翻原因**");
    expect(missingDecisionLogSections(prev, next)).toEqual([
      { number: 1, missing: FULL },
    ]);
  });

  it("accepts a section name carrying a parenthesised suffix", () => {
    const next = HEADER + entry(1, ["老板说", "我推荐（即本次裁决）", "老板采纳", "落点"]);
    expect(missingDecisionLogSections("", next)).toEqual([]);
  });

  it("checks every entry when prevBody is empty", () => {
    const next = HEADER + entry(1, FULL) + entry(2, ["落点"]);
    expect(missingDecisionLogSections("", next)).toEqual([
      { number: 2, missing: ["老板说", "我推荐", "老板采纳"] },
    ]);
  });

  it("ignores a status-line-only edit that keeps the four sections", () => {
    const prev = HEADER + entry(1, FULL);
    const next = prev.replace("· 已定", "· 已被第 2 条推翻") + entry(2, FULL);
    expect(missingDecisionLogSections(prev, next)).toEqual([]);
  });

  it("skips an inherited incomplete entry whose status line is the only change", () => {
    const prev = HEADER + entry(1, ["我推荐"]);
    const next = prev.replace("· 已定", "· 已被第 2 条推翻") + entry(2, FULL);
    expect(missingDecisionLogSections(prev, next)).toEqual([]);
  });

  it("still checks an inherited entry when the body changed alongside the status line", () => {
    const prev = HEADER + entry(1, ["我推荐"]);
    const next = HEADER + entry(1, ["我推荐"], "**推翻原因**").replace("· 已定", "· 已被第 2 条推翻");
    expect(missingDecisionLogSections(prev, next)).toEqual([
      { number: 1, missing: ["老板说", "老板采纳", "落点"] },
    ]);
  });

  it("checks the new entry appended by an overturn writeback", () => {
    const prev = HEADER + entry(1, FULL);
    const next = prev.replace("· 已定", "· 已被第 2 条推翻") + entry(2, ["老板说"]);
    expect(missingDecisionLogSections(prev, next)).toEqual([
      { number: 2, missing: ["我推荐", "老板采纳", "落点"] },
    ]);
  });
});

describe("decisionLogTemplateError", () => {
  it("returns null when nothing is missing", () => {
    expect(decisionLogTemplateError("", HEADER + entry(1, FULL))).toBeNull();
  });

  it("names the entry number, the missing sections and the placeholder wording", () => {
    const message = decisionLogTemplateError("", HEADER + entry(3, ["我推荐", "老板采纳"]));
    expect(message).toContain("第 3 条缺「老板说」「落点」");
    expect(message).toContain("问题 / 老板说（原话照抄）/ 我推荐 / 老板采纳 / 对审意见 / 最终答案 / 落点");
    expect(message).toContain("程序当前硬校验其中四格：老板说 / 我推荐 / 老板采纳 / 落点");
    expect(message).toContain("本条老板未直接发话，由我主动记录");
  });
});

describe("parseDecisionLogEntries · 标题行日期段 (MUL-590)", () => {
  const heading = (line: string) => `${HEADER}${line}\n\n**老板说**\n\n内容\n`;

  it("认带时区的时间戳，原来整条会被跳过", () => {
    const entries = parseDecisionLogEntries(heading("## 1 · 2026-09-07 05:10 PDT · 已定"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ number: 1, date: "2026-09-07 05:10 PDT", status: "已定" });
  });

  it("认数字偏移量", () => {
    const entries = parseDecisionLogEntries(heading("## 2 · 2026-09-07 05:10 +08:00 · 已定"));
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe("2026-09-07 05:10 +08:00");
  });

  it("纯日期和日期加时分照旧", () => {
    expect(parseDecisionLogEntries(heading("## 3 · 2026-09-07 · 已定"))[0]).toMatchObject({
      date: "2026-09-07",
      status: "已定",
    });
    expect(parseDecisionLogEntries(heading("## 4 · 2026-09-07 05:10 · 已定"))[0]).toMatchObject({
      date: "2026-09-07 05:10",
      status: "已定",
    });
  });

  it("状态段带间隔点时仍从第一个间隔点切开", () => {
    const entries = parseDecisionLogEntries(heading("## 5 · 2026-09-07 05:10 PDT · 已被第 11 条推翻"));
    expect(entries[0]).toMatchObject({ date: "2026-09-07 05:10 PDT", status: "已被第 11 条推翻" });
  });

  it("日期段缺失的仍然不算条目", () => {
    expect(parseDecisionLogEntries(heading("## 6 · 本周某天 · 已定"))).toHaveLength(0);
  });
});

describe("unparsedDecisionLogHeadings", () => {
  const bad = "## 7 · 2026-9-7 · 已定";

  it("报出本次新增的、形状像标题却解析不出的行", () => {
    expect(unparsedDecisionLogHeadings("", `${HEADER}${bad}\n\n**老板说**\n\n内容\n`)).toEqual([bad]);
  });

  it("继承来的歪标题不算在本次头上", () => {
    const prev = `${HEADER}${bad}\n\n**老板说**\n\n内容\n`;
    expect(unparsedDecisionLogHeadings(prev, `${prev}${entry(8, FULL)}`)).toEqual([]);
  });

  it("认得出的标题不报", () => {
    expect(unparsedDecisionLogHeadings("", HEADER + entry(1, FULL))).toEqual([]);
  });
});

describe("decisionLogTemplateError · 认不出的标题优先报 (MUL-590)", () => {
  it("先报标题形状，不报成缺格", () => {
    const message = decisionLogTemplateError("", `${HEADER}## 9 · 2026-9-7 · 已定\n\n**老板说**\n\n内容\n`);
    expect(message).toContain("标题行认不出");
    expect(message).toContain("## <编号> · <日期> · <状态>");
    expect(message).not.toContain("缺格");
  });

  it("标题带时区的条目按正常条目查四格", () => {
    const body = `${HEADER}## 10 · 2026-09-07 05:10 PDT · 已定\n\n**我推荐**\n\n内容\n`;
    const message = decisionLogTemplateError("", body);
    expect(message).toContain("第 10 条缺「老板说」「老板采纳」「落点」");
  });
});
