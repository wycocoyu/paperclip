// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenSpec } from "./OpenSpec";

const LISTING = {
  root: "/home/dev/openspec-store",
  available: true,
  files: [
    { path: "AGENTS.md", size: 10, modifiedAt: "2026-01-01T00:00:00.000Z" },
    { path: "openspec/config.yaml", size: 10, modifiedAt: "2026-01-01T00:00:00.000Z" },
    { path: "openspec/specs/工作流/spec.md", size: 10, modifiedAt: "2026-01-01T00:00:00.000Z" },
  ],
};

const mockApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/api/client", () => ({ api: mockApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
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
  return [...container.querySelectorAll('[data-testid="openspec-dir-nav"] [role="treeitem"]')].map((el) => ({
    path: el.getAttribute("data-file-tree-path"),
    level: el.getAttribute("aria-level"),
  }));
}

function pane(container: HTMLElement) {
  return container.querySelector('[data-testid="openspec-file-pane"]')?.textContent ?? "";
}

function respond(listing: unknown = LISTING) {
  mockApi.get.mockImplementation((url: string) => {
    if (url.includes("/openspec/files")) return Promise.resolve(listing);
    const requested = decodeURIComponent(new URL(url, "http://x").searchParams.get("path") ?? "");
    return Promise.resolve({ path: requested, content: `content of ${requested}`, modifiedAt: "" });
  });
}

describe("OpenSpec store browser", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    localStorage.clear();
    respond();
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
          <OpenSpec />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("splits store paths on their slashes into directory and file rows", async () => {
    await render();
    expect(treeRows(container)).toEqual([
      { path: "AGENTS.md", level: "1" },
      { path: "openspec", level: "1" },
      { path: "openspec/config.yaml", level: "2" },
      { path: "openspec/specs", level: "2" },
      { path: "openspec/specs/工作流", level: "3" },
      { path: "openspec/specs/工作流/spec.md", level: "4" },
    ]);
  });

  it("reads the clicked file and shows its body in the right pane", async () => {
    await render();
    expect(pane(container)).toContain("content of AGENTS.md");

    const row = container.querySelector<HTMLElement>('[data-file-tree-path="openspec/specs/工作流/spec.md"]')!;
    await act(async () => row.click());
    await flushReact();
    await flushReact();

    expect(pane(container)).toContain("content of openspec/specs/工作流/spec.md");
    // The path is what the read endpoint is keyed on, so a non-ASCII segment
    // has to survive the round trip percent-encoded.
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/openspec/file?path=openspec%2Fspecs%2F%E5%B7%A5%E4%BD%9C%E6%B5%81%2Fspec.md",
    );
  });

  it("renders a yaml file as a fenced block so the shared markdown renderer can show it", async () => {
    await render();
    const row = container.querySelector<HTMLElement>('[data-file-tree-path="openspec/config.yaml"]')!;
    await act(async () => row.click());
    await flushReact();
    await flushReact();

    expect(pane(container)).toContain("```yaml\ncontent of openspec/config.yaml\n```");
  });

  it("says where the server looked when the checkout is missing", async () => {
    respond({ root: "/home/dev/openspec-store", available: false, files: [] });
    await render();
    expect(container.querySelector('[data-testid="openspec-unavailable"]')?.textContent)
      .toContain("/home/dev/openspec-store");
    expect(container.querySelector('[data-testid="openspec-dir-nav"]')).toBeNull();
  });
});
