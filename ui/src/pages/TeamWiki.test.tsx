// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamWiki } from "./TeamWiki";

const PAGES = [
  { path: "playbooks/decision-log", title: "Decision Log" },
  { path: "playbooks/issue-lifecycle", title: "Issue lifecycle" },
  { path: "terminology/README", title: "术语库" },
].map((page, index) => ({
  id: `page-${index}`,
  companyId: "company-1",
  space: "agent" as const,
  body: `body of ${page.path}`,
  createdByUserId: null,
  createdByAgentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...page,
}));

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/api/client", () => ({ api: mockApi }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "实验室", issuePrefix: "MUL" },
    selectedCompanyId: "company-1",
  }),
}));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "MUL", space: "agent" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/components/PageTabBar", () => ({ PageTabBar: () => null }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function treeRows(container: HTMLElement) {
  return [...container.querySelectorAll('[data-testid="wiki-dir-nav"] [role="treeitem"]')].map((el) => ({
    path: el.getAttribute("data-file-tree-path"),
    level: el.getAttribute("aria-level"),
    expanded: el.getAttribute("aria-expanded"),
  }));
}

function pane(container: HTMLElement) {
  return container.querySelector('[data-testid="wiki-page-pane"]')?.textContent ?? "";
}

describe("TeamWiki tree navigation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    localStorage.clear();
    mockApi.get.mockResolvedValue(PAGES);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TeamWiki />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("splits a page path on its slashes into directory and file rows", async () => {
    await render();
    expect(treeRows(container)).toEqual([
      { path: "playbooks", level: "1", expanded: "true" },
      { path: "playbooks/decision-log", level: "2", expanded: null },
      { path: "playbooks/issue-lifecycle", level: "2", expanded: null },
      { path: "terminology", level: "1", expanded: "true" },
      { path: "terminology/README", level: "2", expanded: null },
    ]);
  });

  it("shows the clicked page's body in the right pane", async () => {
    await render();
    expect(pane(container)).toContain("body of playbooks/decision-log");

    const row = container.querySelector<HTMLElement>('[data-file-tree-path="terminology/README"]')!;
    await act(async () => row.click());
    await flushReact();

    expect(pane(container)).toContain("术语库");
    expect(pane(container)).toContain("body of terminology/README");
  });

  it("restores collapsed directories from localStorage across a remount", async () => {
    await render();
    const dir = container.querySelector<HTMLElement>('[data-file-tree-path="playbooks"]')!;
    await act(async () => dir.click());
    await flushReact();
    expect(treeRows(container).map((r) => r.path)).toEqual(["playbooks", "terminology", "terminology/README"]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    expect(treeRows(container).map((r) => r.path)).toEqual(["playbooks", "terminology", "terminology/README"]);
  });

  it("falls back to the first remaining page when the selected one drops out", async () => {
    await render();
    const row = container.querySelector<HTMLElement>('[data-file-tree-path="terminology/README"]')!;
    await act(async () => row.click());
    await flushReact();
    expect(pane(container)).toContain("body of terminology/README");

    mockApi.get.mockResolvedValue(PAGES.slice(0, 2));
    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索页面"]')!;
    // React tracks the input's value through its own descriptor, so assigning
    // `.value` directly is invisible to onChange.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(search, "decision");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (let i = 0; i < 6; i++) await flushReact();

    expect(pane(container)).toContain("body of playbooks/decision-log");
  });
});
