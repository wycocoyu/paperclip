import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN, FEISHU_ISSUE_WIKI_URL_PREFIX } from "@paperclipai/shared";
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
type WorkProductRow = { type: string; url: string | null; metadata: unknown };

function makeDb(docs: DocRow[], decidedDecision = true, workProducts: WorkProductRow[] = []) {
  let call = 0;
  // 既可 await 也可 .limit(1)（docs / work-products 查询直接 await，decisions 查询链尾有 .limit）
  const queryResult = (rows: unknown[]) => ({
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
    limit: async () => rows,
  });
  // 调用顺序 = 实现里的查询顺序：文档 → work products（MUL-603 wiki 通路）→ 决策
  const where = () => {
    call += 1;
    if (call === 1) return queryResult(docs);
    if (call === 2) return queryResult(workProducts);
    return queryResult(decidedDecision ? [{ id: "decision-1" }] : []);
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

describe("missingIssueClosePrerequisites · 飞书 wiki 通路（MUL-603）", () => {
  const wikiDoc = (overrides: Partial<WorkProductRow> = {}): WorkProductRow => ({
    type: "document",
    url: `${FEISHU_ISSUE_WIKI_URL_PREFIX}Nn3ew8cFhiIlk6kBNkkcBgMYnTe`,
    metadata: { parentNodeToken: FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN },
    ...overrides,
  });
  const onlyDecisionLog = BASE_DOCS.filter((d) => d.key === "decision-log");

  it("卡内两份文档都没有，但挂了合规 wiki 链接 → 放行", async () => {
    const missing = await missingIssueClosePrerequisites(
      makeDb(onlyDecisionLog, true, [wikiDoc()]),
      "co",
      issue(),
    );
    expect(missing).toEqual([]);
  });

  it("子卡目录：只声明 rootNodeToken（直接父节点是父卡目录）→ 认", async () => {
    const missing = await missingIssueClosePrerequisites(
      makeDb(onlyDecisionLog, true, [wikiDoc({ metadata: {
        rootNodeToken: FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN,
        parentNodeToken: "N8oowjWdZieJ4HkYCPdcbrQ4nhb",
      } })]),
      "co",
      issue(),
    );
    expect(missing).toEqual([]);
  });

  it("存量记录只有 parentNodeToken=固定页 → 仍认（迭代只改机制，存量不补）", async () => {
    const missing = await missingIssueClosePrerequisites(
      makeDb(onlyDecisionLog, true, [wikiDoc({ metadata: { parentNodeToken: FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN } })]),
      "co",
      issue(),
    );
    expect(missing).toEqual([]);
  });

  it("wiki 链接的 root/parentNodeToken 都不是固定页 → 不认，仍按老路拦", async () => {
    const missing = await missingIssueClosePrerequisites(
      makeDb(onlyDecisionLog, true, [wikiDoc({ metadata: { rootNodeToken: "SomeOtherRoot", parentNodeToken: "SomeOtherNodeToken" } })]),
      "co",
      issue(),
    );
    expect(missing.some((m) => m.includes("需求设计"))).toBe(true);
  });

  it("飞书链接但不在 wiki 路径下 → 不认", async () => {
    const missing = await missingIssueClosePrerequisites(
      makeDb(onlyDecisionLog, true, [wikiDoc({ url: "https://hellotalk.feishu.cn/docx/X5QLd6TnRoJEX2xfeVYcIVLjnZg" })]),
      "co",
      issue(),
    );
    expect(missing.some((m) => m.includes("需求设计"))).toBe(true);
  });

  it("两条路都不满足时，报错同时给出卡内文档与 wiki 两种修法", async () => {
    const missing = await missingIssueClosePrerequisites(makeDb(onlyDecisionLog), "co", issue());
    expect(missing.some((m) => m.includes("document:put"))).toBe(true);
    expect(missing.some((m) => m.includes("work-product:create") && m.includes(FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN))).toBe(true);
  });

  it("走 wiki 通路的代码卡不再判门禁 A（验证证据在 CLI 侧校验）", async () => {
    const docs = [
      ...onlyDecisionLog,
      { key: "tech-proposal", body: "# 方案，无验证无代码块" },
    ];
    const missing = await missingIssueClosePrerequisites(
      makeDb(docs, true, [wikiDoc()]),
      "co",
      issue({ workingBranch: "feature/wy/MUL-603/gate-wiki-link" }),
    );
    expect(missing).toEqual([]);
  });

  it("没有 wiki 链接的代码卡，门禁 A 照旧生效", async () => {
    const docs = BASE_DOCS.map((d) =>
      d.key === "tech-proposal" ? { key: d.key, body: "# 方案，无验证无代码块" } : d,
    );
    const missing = await missingIssueClosePrerequisites(
      makeDb(docs, true, []),
      "co",
      issue({ workingBranch: "feature/wy/MUL-603/gate-wiki-link" }),
    );
    expect(missing.some((m) => m.includes("验证证据"))).toBe(true);
  });
});
