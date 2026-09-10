// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { IssueDoneNotice } from "./IssueDoneNotice";

const { listDocuments } = vi.hoisted(() => ({ listDocuments: vi.fn() }));

vi.mock("@/api/issues", () => ({ issuesApi: { listDocuments } }));

const DEFAULT_DOCS = [
  { key: "requirements" },
  { key: "tech-proposal" },
  { key: "review-r1-codex" },
];

/** 一条填好的决策，标题形状要真，靠它区分「填过」和「只是播了骨架」。 */
const ONE_ENTRY = [
  "# decision-log · MUL-1",
  "",
  "## 1 · 2026-09-09 08:00 · 已定",
  "",
  "**老板说**",
  "",
  "全采纳",
].join("\n");

/** 开卡播种出来的样子：示例条目的日期是占位符，解析不出条目。 */
const SEEDED_ONLY = [
  "# decision-log · MUL-1",
  "",
  "## 1 · YYYY-MM-DD HH:MM · 待定 / 已定 / 已被第 N 条推翻",
  "",
  "**老板说**",
  "",
  "> 原话照抄，不转述、不截断",
].join("\n");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** retry: false 让失败的查询立刻结束，否则测试要等重试退避。 */
function renderWithClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

beforeEach(() => {
  listDocuments.mockReset();
  listDocuments.mockResolvedValue(DEFAULT_DOCS);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/** 查询是异步的，轮询到材料索引出现为止，别用固定次数的 microtask 猜时序。 */
async function waitForMaterials() {
  for (let i = 0; i < 50 && !container.textContent?.includes("留下的材料"); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("IssueDoneNotice", () => {
  it("renders the past-tense notice when the issue is done", () => {
    renderWithClient(<IssueDoneNotice issueStatus="done" />);

    expect(container.textContent).toContain("本 issue 为过去时");
    expect(container.textContent).toContain("一切以当前为准");
  });

  it("renders nothing while the issue is still open", () => {
    renderWithClient(<IssueDoneNotice issueStatus="in_progress" />);

    expect(container.textContent).toBe("");
  });

  it("lists the materials the closed card left behind", async () => {
    renderWithClient(<IssueDoneNotice issueStatus="done" issueId="issue-1" />);
    await waitForMaterials();

    expect(container.textContent).toContain("留下的材料：需求底稿、技术方案");
    // 不是四样材料之一的文档不进索引，否则一张卡的评审轮次会把这行撑爆。
    expect(container.textContent).not.toContain("review-r1-codex");
  });

  // 开卡播种之后每张卡都有 decision-log，按存在性报等于全线假绿（MUL-590）。
  it("counts entries for the decision log instead of the document existing", async () => {
    listDocuments.mockResolvedValue([...DEFAULT_DOCS, { key: "decision-log", body: SEEDED_ONLY }]);
    renderWithClient(<IssueDoneNotice issueStatus="done" issueId="issue-1" />);
    await waitForMaterials();

    expect(container.textContent).toContain("留下的材料：需求底稿、技术方案");
    expect(container.textContent).not.toContain("决策过程");
  });

  it("lists the decision log once it holds a real entry", async () => {
    listDocuments.mockResolvedValue([...DEFAULT_DOCS, { key: "decision-log", body: ONE_ENTRY }]);
    renderWithClient(<IssueDoneNotice issueStatus="done" issueId="issue-1" />);
    await waitForMaterials();

    expect(container.textContent).toContain("留下的材料：需求底稿、技术方案、决策过程");
  });
});
