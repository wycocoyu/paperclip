import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { missingIssueClosePrerequisites } from "./issue-prerequisites.js";

/**
 * MUL-558 双门禁红绿测试：
 *  A. 代码卡（登记了 workingBranch）收卡时 tech-proposal 须含「验证」字样
 *     与至少一个 ``` 围栏块——只判在不在，不判真假。
 *  B. 基线对比（opt-in）：卡上有 test-baseline 文档时，收卡须有同构
 *     test-result，且新增失败（result − baseline）为空。
 * 连同 MUL-137 既有三件套的回归用例。
 */

type DocRow = { key: string; body: string | null };

function makeDb(docs: DocRow[], decidedDecision = true) {
  let call = 0;
  // 既可 await 也可 .limit(1)（docs 查询直接 await，decisions 查询链尾有 .limit）
  const queryResult = (rows: unknown[]) => ({
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
    limit: async () => rows,
  });
  const where = () => {
    call += 1;
    return queryResult(call === 1 ? docs : decidedDecision ? [{ id: "decision-1" }] : []);
  };
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where }),
        where,
      }),
    }),
  };
  return db as unknown as Pick<Db, "select">;
}

const BASE_DOCS: DocRow[] = [
  { key: "requirements", body: "# 需求" },
  { key: "tech-proposal", body: "# 方案\n\n## 验证方式\n\n```\nvitest run\n# 12 passed\n```" },
  { key: "decision-log", body: "# decision-log" },
];

const issue = (overrides: Record<string, unknown> = {}) => ({
  id: "issue-1",
  description: "> 一句话。",
  workingBranch: null as string | null,
  ...overrides,
});

describe("missingIssueClosePrerequisites · MUL-137 回归", () => {
  it("三件套齐 + 已定决策 → 无缺失", async () => {
    const missing = await missingIssueClosePrerequisites(makeDb(BASE_DOCS), "co", issue());
    expect(missing).toEqual([]);
  });

  it("缺 requirements → 提示补文档", async () => {
    const docs = BASE_DOCS.filter((d) => d.key !== "requirements");
    const missing = await missingIssueClosePrerequisites(makeDb(docs), "co", issue());
    expect(missing.some((m) => m.includes("需求设计"))).toBe(true);
  });
});

describe("missingIssueClosePrerequisites · 门禁 A：代码卡验证证据（MUL-558）", () => {
  it("登记了分支但 tech-proposal 无代码块 → 拦", async () => {
    const docs = BASE_DOCS.map((d) =>
      d.key === "tech-proposal" ? { key: d.key, body: "# 方案\n\n## 验证方式\n\n跑测试。" } : d,
    );
    const missing = await missingIssueClosePrerequisites(makeDb(docs), "co", issue({ workingBranch: "feature/wy/X/y" }));
    expect(missing.some((m) => m.includes("验证证据"))).toBe(true);
  });

  it("登记了分支、tech-proposal 无「验证」字样 → 拦", async () => {
    const docs = BASE_DOCS.map((d) =>
      d.key === "tech-proposal" ? { key: d.key, body: "# 方案\n\n```\nsome command\n```" } : d,
    );
    const missing = await missingIssueClosePrerequisites(makeDb(docs), "co", issue({ workingBranch: "feature/wy/X/y" }));
    expect(missing.some((m) => m.includes("验证证据"))).toBe(true);
  });

  it("登记了分支、有验证字样 + 围栏块 → 放行", async () => {
    const missing = await missingIssueClosePrerequisites(makeDb(BASE_DOCS), "co", issue({ workingBranch: "feature/wy/X/y" }));
    expect(missing).toEqual([]);
  });

  it("未登记分支的卡不检查（快车道）", async () => {
    const docs = BASE_DOCS.map((d) =>
      d.key === "tech-proposal" ? { key: d.key, body: "# 纯调研方案，无代码" } : d,
    );
    const missing = await missingIssueClosePrerequisites(makeDb(docs), "co", issue());
    expect(missing).toEqual([]);
  });
});

describe("missingIssueClosePrerequisites · 门禁 B：基线对比（MUL-558）", () => {
  const withDoc = (docs: DocRow[], extra: DocRow) => [...docs.filter((d) => d.key !== extra.key), extra];

  it("有 baseline 无 result → 拦并给修法", async () => {
    const docs = withDoc(BASE_DOCS, { key: "test-baseline", body: JSON.stringify({ command: "vitest run", failures: ["a.test"] }) });
    const missing = await missingIssueClosePrerequisites(makeDb(docs), "co", issue());
    expect(missing.some((m) => m.includes("test-result"))).toBe(true);
  });

  it("result 有 baseline 没有的失败 → 拦并列出新增失败", async () => {
    const docs = [
      ...withDoc(BASE_DOCS, { key: "test-baseline", body: JSON.stringify({ command: "vitest run", failures: ["old.test"] }) }),
      { key: "test-result", body: JSON.stringify({ command: "vitest run", failures: ["old.test", "new.test"] }) },
    ];
    const missing = await missingIssueClosePrerequisites(makeDb(docs), "co", issue());
    expect(missing.some((m) => m.includes("new.test"))).toBe(true);
  });

  it("result 失败是 baseline 子集 → 放行", async () => {
    const docs = [
      ...withDoc(BASE_DOCS, { key: "test-baseline", body: JSON.stringify({ command: "vitest run", failures: ["old.test", "known.test"] }) }),
      { key: "test-result", body: JSON.stringify({ command: "vitest run", failures: ["old.test"] }) },
    ];
    const missing = await missingIssueClosePrerequisites(makeDb(docs), "co", issue());
    expect(missing).toEqual([]);
  });

  it("baseline/result 非 JSON 或缺 failures 数组 → 拦并提示结构化", async () => {
    const docs = [
      ...withDoc(BASE_DOCS, { key: "test-baseline", body: "随便写的自由文本" }),
      { key: "test-result", body: JSON.stringify({ failures: "not-an-array" }) },
    ];
    const missing = await missingIssueClosePrerequisites(makeDb(docs), "co", issue());
    expect(missing.some((m) => m.includes("JSON"))).toBe(true);
  });

  it("无 baseline 的卡不受限（opt-in）", async () => {
    const missing = await missingIssueClosePrerequisites(makeDb(BASE_DOCS), "co", issue());
    expect(missing).toEqual([]);
  });
});
