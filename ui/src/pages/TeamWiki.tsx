import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, BookOpen, History, Pencil, RotateCcw, Save, Search, Trash2, X } from "lucide-react";
import { useNavigate, useParams } from "@/lib/router";
import { api } from "@/api/client";
import { agentsApi } from "@/api/agents";
import { agentCustomIcon } from "@/components/AgentIconPicker";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "@/components/MarkdownBody";
import { FileTree, buildFileTree, collectAllPaths } from "@/components/FileTree";
import { useResizableRail } from "@/hooks/useResizableRail";
import { CopyText } from "@/components/CopyText";
import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import {
  RevisionDiffDialog,
  revisionDiffSelection,
  revisionLabel,
} from "@/components/RevisionDiffDialog";
import { cn, relativeTime } from "@/lib/utils";

/** Kept in step with the `team_wiki_pages_space_check` constraint. */
const SPACES = ["paperclip", "agent", "personal"] as const;
type Space = (typeof SPACES)[number];
/** The team page's switcher shows team spaces only; personal lives behind its
 *  own Personal assets entry (tabs isolated, machinery shared — user 2026-08-26). */
const TEAM_SPACES = ["agent", "paperclip"] as const;
/** Tool tabs render proper casing even though paths are lowercase. */
const TOOL_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  zcode: "Zcode",
  grok: "Grok",
};
const toolLabel = (tool: string) => TOOL_LABELS[tool] ?? tool;

const TOOL_COLORS: Record<string, string> = {
  claude: "#D97757",
  codex: "#10A37F",
  grok: "#6366f1",
  zcode: "#2563eb",
};

/**
 * Personal-file tabs are derived from path prefixes (`claude/CLAUDE.md`), not
 * from agent records, so the tool has to be matched back to its agent by name
 * to reach the real provider logo the agent already carries. The previous
 * /brands/*.svg files were only lettered discs standing in for logos, so a
 * tool with no matching agent now gets a plain colour dot instead of a
 * made-up wordmark.
 */
function useToolBrandIcons(companyId: string | null) {
  const agentsQuery = useQuery({
    queryKey: companyId ? [...queryKeys.agents.list(companyId), "tool-brands"] : ["agents", "tool-brands", "none"],
    queryFn: () => agentsApi.list(companyId!, { includeTerminated: true }),
    enabled: Boolean(companyId),
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agentsQuery.data ?? []) {
      const icon = agentCustomIcon(agent);
      if (!icon) continue;
      const name = agent.name.toLowerCase();
      for (const tool of Object.keys(TOOL_COLORS)) {
        if (name.startsWith(tool) && !map.has(tool)) map.set(tool, icon);
      }
    }
    return map;
  }, [agentsQuery.data]);
}

function ToolBrandIcon({ tool, iconUrl }: { tool: string; iconUrl?: string | null }) {
  const color = TOOL_COLORS[tool];
  if (!color) return null;
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        className="mr-1.5 inline-block h-4 w-4 shrink-0 rounded-full object-cover align-text-bottom"
        aria-hidden
      />
    );
  }
  return (
    <span
      className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full align-middle"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

const SPACE_META: Record<Space, { label: string; blurb: string }> = {
  paperclip: {
    label: "Paperclip Wiki",
    blurb: "写给人看：Paperclip 自身的文档、架构、怎么使用PaperClip的功能以及人要守的约定",
  },
  agent: {
    label: "Agent Wiki",
    blurb: "写给 Agent 看：可执行的步骤、判定条件、边界、反例。判据是「读完能直接行动」、不是「读着顺」。",
  },  personal: {
    label: "个人指令",
    blurb: "个人层指令文件（全局 CLAUDE.md / AGENTS.md）：真身在文件系统，这里管登记与快照版本，回滚=导出后手动覆盖。",
  },
};

/**
 * The archive holds pages from both team spaces, so it files them under a
 * folder per space. Without that prefix a path archived from both spaces
 * would collide into one tree row.
 */
function archiveTreePath(page: TeamWikiPage) {
  return `${SPACE_META[page.space]?.label ?? page.space}/${page.path}`;
}

interface TeamWikiPage {
  id: string;
  companyId: string;
  space: Space;
  path: string;
  title: string;
  body: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TeamWikiPageVersion {
  id: string;
  pageId: string;
  revisionNumber: number;
  path: string;
  title: string;
  body: string;
  label: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdAt: string;
}

/** `scope` is a space, or "archived" for the cross-space archive shelf (MUL-455). */
function pagesKey(companyId: string | null, scope: Space | "archived", query: string) {
  return ["team-wiki", "pages", companyId, scope, query];
}

function versionsKey(companyId: string | null, pageId: string) {
  return ["team-wiki", "pages", companyId, pageId, "versions"];
}

function isSpace(value: string | undefined): value is Space {
  return SPACES.some((space) => space === value);
}

/**
 * Pages store an author id, so resolve names once per company — a reader wants
 * to know which teammate wrote a page, and "agent" alone doesn't answer that.
 */
function useAgentNames(companyId: string | null) {
  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "team-wiki", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agentsQuery.data]);
}

function authorLabel(agentId: string | null, agentNames: Map<string, string>) {
  if (!agentId) return null;
  return agentNames.get(agentId) ?? "已移除的 Agent";
}

/**
 * The page body is a snapshot, not a live mirror. A PostToolUse hook
 * (scripts/hooks/personal-file-sync.sh) covers only edits made through a coding
 * agent's Write/Edit tool; a hand edit in an editor reaches no hook, so the
 * page silently lags until someone runs `personal-file sync`. Which half you
 * are in is exactly what a reader can't tell from the page, so it's spelled out
 * here rather than left to be discovered.
 */
function PersonalSyncHelp({ companyId }: { companyId: string | null }) {
  const [open, setOpen] = useState(false);
  const company = companyId ?? "<company-id>";
  const steps: Array<{ label: string; command: string; note?: string }> = [
    {
      label: "查页面 id 和登记的文件路径",
      command: `paperclipai personal-file list -C ${company}`,
      note: "输出里的 title 就是这台机器上的文件绝对路径，sync 按它去读文件。",
    },
    {
      label: "手动同步（自己在编辑器里改完，跑这条）",
      command: `paperclipai personal-file sync -C ${company} <pageId> --label "改了什么"`,
      note: "内容和最新版本一致时打印 unchanged，不产生新版本，重复跑没有副作用。",
    },
    {
      label: "首次登记一个新文件",
      command: `paperclipai personal-file register -C ${company} --kind claude/CLAUDE.md --path /Users/你/.claude/CLAUDE.md`,
      note: "--kind 是这里的页面路径，--path 是文件在本机的绝对路径；登记后再跑一次 sync 才有内容。",
    },
    {
      label: "回滚",
      command: `paperclipai personal-file show -C ${company} <pageId> --revision <n> > /Users/你/.claude/CLAUDE.md`,
      note: "这里只导出，不会替你写文件——覆盖是手动的那一步。",
    },
    {
      label: "确认自动同步这条路通着",
      command: `grep personal-file-sync ~/.claude/settings.json`,
      note: "没有输出就是 hook 没装，Agent 改文件也不会存版本；hook 脚本在 scripts/hooks/personal-file-sync.sh，挂在 PostToolUse 的 Write|Edit 上。",
    },
  ];

  return (
    <div className="rounded-lg border border-border p-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <span className="text-sm font-medium text-foreground">
          本机改了 CLAUDE.md 之后，怎么同步到这里
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{open ? "收起" : "展开"}</span>
      </button>
      <p className="mt-1 text-sm text-muted-foreground">
        这里的页面是快照。让编码 Agent（Claude Code 等）改这些文件时会自动存一版，靠的是
        Paperclip 装的 PostToolUse hook；自己在编辑器里手改不会触发，得回终端跑一次 sync。
      </p>
      {open ? (
        <ol className="mt-3 space-y-3">
          {steps.map((step, index) => (
            <li key={step.label} className="text-sm">
              <span className="font-medium text-foreground">
                {index + 1}. {step.label}
              </span>
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs text-foreground">
                <code>{step.command}</code>
              </pre>
              {step.note ? <p className="mt-1 text-xs text-muted-foreground">{step.note}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** Expanded directories survive a reload, keyed per company + space. */
const WIKI_EXPANDED_STORAGE_PREFIX = "paperclip.team-wiki.expanded";

function readExpandedDirs(storageKey: string, fallback: ReadonlySet<string>): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return new Set(fallback);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(fallback);
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
  } catch {
    return new Set(fallback);
  }
}

function writeExpandedDirs(storageKey: string, dirs: ReadonlySet<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...dirs].sort()));
  } catch {
    // A blocked or full store only costs the reload-time restore.
  }
}

/**
 * Team spaces browse as a file tree on the left and one page's body on the
 * right. Directories come from the slashes in a page's path; a directory with
 * no page under it has no row, because the store holds pages, not folders.
 *
 * The caller remounts this per company + space through `key`, so the
 * localStorage seed is read once per storage key rather than resynced by an
 * effect.
 */
function WikiTreeBrowser({
  pages,
  storageKey,
  renderPage,
  pathOf,
}: {
  pages: TeamWikiPage[];
  storageKey: string;
  renderPage: (page: TeamWikiPage) => ReactNode;
  /** The archive is cross-space, so it files each row under its space and can
   *  still hold the same path twice; the tree needs one row per page. */
  pathOf?: (page: TeamWikiPage) => string;
}) {
  // A tree row is addressed by its path, but two pages can share one, so a
  // repeat gets a numbered suffix rather than silently swallowing the page.
  const entries = useMemo(() => {
    const seen = new Map<string, number>();
    return pages.map((page) => {
      const base = pathOf ? pathOf(page) : page.path;
      const nth = (seen.get(base) ?? 0) + 1;
      seen.set(base, nth);
      return { key: nth === 1 ? base : `${base} (${nth})`, page };
    });
  }, [pages, pathOf]);
  const nodes = useMemo(
    () => buildFileTree(Object.fromEntries(entries.map((entry) => [entry.key, true]))),
    [entries],
  );
  const filePaths = useMemo(() => [...collectAllPaths(nodes, "file")], [nodes]);
  const [expandedDirs, setExpandedDirs] = useState(() =>
    readExpandedDirs(storageKey, collectAllPaths(nodes, "dir")),
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const rail = useResizableRail({ storageKey: "paperclip.teamWiki.railWidth" });

  // A search or an archive can retire the selected path mid-session, so fall
  // back to the first page instead of leaving the reading pane blank.
  const activePath =
    selectedPath && filePaths.includes(selectedPath) ? selectedPath : (filePaths[0] ?? null);
  const activePage = entries.find((entry) => entry.key === activePath)?.page ?? null;

  function toggleDir(path: string) {
    const next = new Set(expandedDirs);
    if (!next.delete(path)) next.add(path);
    setExpandedDirs(next);
    writeExpandedDirs(storageKey, next);
  }

  return (
    <div className="flex min-h-0 w-full flex-col sm:flex-row">
      <nav
        className="relative shrink-0 overflow-y-auto border-b border-border py-3 sm:w-[var(--rail-w)] sm:border-b-0 sm:border-r"
        style={rail.railStyle}
        aria-label="目录"
        data-testid="wiki-dir-nav"
      >
        <p className="mb-1 px-4 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
          目录
        </p>
        <FileTree
          nodes={nodes}
          selectedFile={activePath}
          expandedDirs={expandedDirs}
          onToggleDir={toggleDir}
          onSelectFile={setSelectedPath}
          showCheckboxes={false}
          // The rail is sized to hold a whole page name on one line; FileTree's
          // default break-all would fold long ones onto a second row anyway.
          wrapLabels={false}
          ariaLabel="Wiki 目录"
          empty={{ title: "还没有页面" }}
        />
        {/* 手柄压在 rail 右缘上，`relative` 由 nav 自己提供。before 伪元素画那条
            一像素的线，只在悬停、聚焦或拖动时显形，静止时不给页面加视觉噪音。 */}
        <div
          {...rail.handleProps}
          data-testid="wiki-rail-handle"
          className={`absolute inset-y-0 right-0 z-20 hidden w-3 cursor-col-resize touch-none outline-none sm:block
            before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors
            hover:before:bg-border focus-visible:before:bg-ring ${rail.isResizing ? "before:bg-ring" : ""}`}
        />
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5" data-testid="wiki-page-pane">
        {activePage ? (
          // The pane spans the rest of the window, but prose past ~1024px is
          // hard to read, so the body keeps its own cap inside it.
          <div className="w-full">{renderPage(activePage)}</div>
        ) : (
          <p className="text-xs text-muted-foreground">从左侧目录选一个页面。</p>
        )}
      </div>
    </div>
  );
}

export function TeamWiki({ fixedSpace }: { fixedSpace?: Space } = {}) {
  const params = useParams();
  const navigate = useNavigate();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const agentNames = useAgentNames(selectedCompanyId);
  const toolBrandIcons = useToolBrandIcons(selectedCompanyId);

  const space: Space = fixedSpace ?? (isSpace(params.space) ? params.space : "agent");
  /**
   * 归档 (MUL-455): a third tab beside the two team spaces, showing every
   * retired page in the company. One shelf rather than one per space, because
   * someone hunting a retired page remembers what it said, not where it lived.
   */
  const isArchive = !fixedSpace && params.space === "archived";
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<{ title: string; path: string; body: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const prefix = selectedCompany?.issuePrefix ?? "";
  const query = search.trim();

  const pagesQuery = useQuery({
    queryKey: pagesKey(selectedCompanyId, isArchive ? "archived" : space, query),
    queryFn: () =>
      api.get<TeamWikiPage[]>(
        isArchive
          ? `/companies/${selectedCompanyId}/team-wiki-archive${query ? `?q=${encodeURIComponent(query)}` : ""}`
          : `/companies/${selectedCompanyId}/team-wiki/${space}/pages${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      ),
    enabled: Boolean(selectedCompanyId),
  });

  function invalidatePages() {
    // Archiving moves a page between two lists, so both have to be dropped or
    // the row lingers on the shelf it just left.
    queryClient.invalidateQueries({ queryKey: ["team-wiki", "pages", selectedCompanyId] });
  }

  const setArchived = useMutation({
    mutationFn: ({ page, archived }: { page: TeamWikiPage; archived: boolean }) =>
      api.post<TeamWikiPage>(
        `/companies/${selectedCompanyId}/team-wiki/${page.space}/pages/${page.id}/${archived ? "archive" : "unarchive"}`,
        {},
      ),
    onSuccess: (_data, variables) => {
      invalidatePages();
      pushToast({ title: variables.archived ? "已归档" : "已恢复" });
    },
    onError: (error: Error) => pushToast({ title: "操作失败", body: error.message, tone: "error" }),
  });

  const createPage = useMutation({
    mutationFn: (payload: { title: string; path: string; body: string }) =>
      api.post<TeamWikiPage>(`/companies/${selectedCompanyId}/team-wiki/${space}/pages`, payload),
    onSuccess: () => {
      invalidatePages();
      setDraft(null);
    },
    onError: (error: Error) => pushToast({ title: "创建失败", body: error.message, tone: "error" }),
  });

  const updatePage = useMutation({
    mutationFn: (payload: { id: string; title: string; path: string; body: string }) =>
      api.patch<TeamWikiPage>(`/companies/${selectedCompanyId}/team-wiki/${space}/pages/${payload.id}`, {
        title: payload.title,
        path: payload.path,
        body: payload.body,
      }),
    onSuccess: (_data, payload) => {
      invalidatePages();
      queryClient.invalidateQueries({ queryKey: versionsKey(selectedCompanyId, payload.id) });
      setEditing(null);
    },
    onError: (error: Error) => pushToast({ title: "保存失败", body: error.message, tone: "error" }),
  });

  const deletePage = useMutation({
    mutationFn: (id: string) => api.delete(`/companies/${selectedCompanyId}/team-wiki/${space}/pages/${id}`),
    onSuccess: () => invalidatePages(),
  });

  const pages = pagesQuery.data ?? [];
  const meta = SPACE_META[space];

  // Personal entry: tabs per tool (first path segment), so four global
  // directive files don't stack into one long scroll (user 2026-08-26).
  const tools = fixedSpace
    ? [...new Set(pages.map((p) => p.path.split("/")[0]))].sort()
    : [];
  const [toolTab, setToolTab] = useState<string>("all");
  const visiblePages = fixedSpace && toolTab !== "all"
    ? pages.filter((p) => p.path.split("/")[0] === toolTab)
    : pages;

  // Team spaces: directory grouping — the path's first segment becomes the
  // section header; root-level pages render above the sections.
  const rootPages = visiblePages.filter((p) => !p.path.includes("/"));
  const dirGroups = [...new Set(
    visiblePages.filter((p) => p.path.includes("/")).map((p) => p.path.split("/")[0]),
  )].sort();
  const [dirTab, setDirTab] = useState<string>("all");
  const filteredPages = fixedSpace
    ? visiblePages
    : dirTab === "all"
      ? visiblePages
      : dirTab === "__root__"
        ? rootPages
        : visiblePages.filter((p) => p.path.startsWith(dirTab + "/"));

  /**
   * The tree view shows one page in its right pane while the archive shelf and
   * the personal tabs still list every page, so the card markup is shared.
   */
  function renderPageCard(page: TeamWikiPage) {
    return editing === page.id ? (
      <PageEditor
        page={page}
        onSave={(title, path, body) => updatePage.mutate({ id: page.id, title, path, body })}
        onCancel={() => setEditing(null)}
        pending={updatePage.isPending}
      />
    ) : (
      <>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-mono text-(length:--text-micro) text-muted-foreground">
              <span className="truncate">{page.path}</span>
              {/* A path moves when a page is renamed, so anything that has to
                  point at this page later (a card, a script, the CLI's
                  <pathOrId> argument) should carry the id instead. Shown
                  short, copied in full. */}
              <CopyText
                text={page.id}
                className="shrink-0 font-mono opacity-70"
                ariaLabel="复制页面 ID"
                title={`页面 ID ${page.id}（点击复制完整 ID）`}
                copiedLabel="已复制完整 ID"
              >
                {page.id.slice(0, 8)}
              </CopyText>
            </p>
            <h3 className="text-sm font-semibold">{page.title}</h3>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="版本历史"
              title="版本历史"
              onClick={() => setHistoryFor((current) => (current === page.id ? null : page.id))}
            >
              <History className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="编辑" onClick={() => setEditing(page.id)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </Button>
            {/* 归档 (MUL-455) sits before 删除 on purpose: it is the
                reversible neighbour of an irreversible button, and a
                reader scanning left to right should meet it first. */}
            {isArchive ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="恢复"
                title="放回原空间"
                disabled={setArchived.isPending}
                onClick={() => setArchived.mutate({ page, archived: false })}
              >
                <ArchiveRestore className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="归档"
                title="归档（正文与历史保留，可恢复）"
                disabled={setArchived.isPending}
                onClick={() => setArchived.mutate({ page, archived: true })}
              >
                <Archive className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="删除"
              onClick={() => {
                if (window.confirm(`删除页面「${page.title}」？版本历史会一并删除。`)) deletePage.mutate(page.id);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          <MarkdownBody>{page.body || "_（空）_"}</MarkdownBody>
        </div>
        <p className="mt-2 text-(length:--text-micro) text-muted-foreground">
          更新于 {new Date(page.updatedAt).toLocaleString()}
          {authorLabel(page.createdByAgentId, agentNames)
            ? ` · ${authorLabel(page.createdByAgentId, agentNames)} 创建`
            : ""}
        </p>
        {historyFor === page.id ? (
          <PageVersions
            companyId={selectedCompanyId}
            space={space}
            pageId={page.id}
            agentNames={agentNames}
            onRestored={invalidatePages}
          />
        ) : null}
      </>
    );
  }

  // Every team tab browses as a tree, the archive included (user 2026-09-09:
  // "归档也像其他两个 wiki 一样"). Only the personal files stay a flat list.
  const showTree = !fixedSpace;
  const expandedStorageKey = `${WIKI_EXPANDED_STORAGE_PREFIX}:${selectedCompanyId ?? "global"}:${isArchive ? "archived" : space}`;

  /**
   * A tree space owns the whole main area: the rail has to reach the app
   * sidebar, so it cancels <main>'s padding the way RoutineDetail does. The
   * personal files are a flat list that reads fine in the centred column, so
   * they keep it.
   */
  return (
    <div
      className={
        showTree
          ? "-m-4 flex min-h-0 flex-col space-y-4 px-6 pt-5 sm:h-full md:-m-6"
          : "mx-auto w-full max-w-4xl space-y-6 px-6 py-8"
      }
    >
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <BookOpen className="h-5 w-5 text-sky-600 dark:text-sky-400" aria-hidden />{" "}
          {fixedSpace === "personal" ? "个人指令文件" : "Team Wiki"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {fixedSpace === "personal"
            ? "个人层指令文件的登记与快照版本；真身在文件系统，回滚=导出后手动覆盖"
            : "团队的知识作为一个 workspace 给 Agent"}
        </p>
      </header>

      {/* PageTabBar renders Radix triggers, so the change event arrives on the
          surrounding Tabs — wiring only the inner prop leaves the tabs inert. */}
      {fixedSpace ? null : (
        <Tabs value={isArchive ? "archived" : space} onValueChange={(next) => navigate(`/${prefix}/team-wiki/${next}`)}>
          <PageTabBar
            align="start"
            value={isArchive ? "archived" : space}
            onValueChange={(next) => navigate(`/${prefix}/team-wiki/${next}`)}
            items={[
              ...TEAM_SPACES.map((value) => ({ value, label: SPACE_META[value].label })),
              { value: "archived", label: "归档" },
            ]}
          />
        </Tabs>
      )}

      <p className="text-sm text-muted-foreground">{meta.blurb}</p>

      {space === "personal" ? <PersonalSyncHelp companyId={selectedCompanyId} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索标题、正文、路径…"
            aria-label="搜索页面"
            className="pl-8"
          />
        </div>
        {/* The archive is a shelf, not a space: a new page has to belong to
            one, so it is created from that space's own tab. */}
        {isArchive ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDraft({ title: "", path: "", body: "" })}
          >
            新建页面
          </Button>
        )}
      </div>

      {draft ? (
        <div className="space-y-2 rounded-lg border border-border p-4">
          <Input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="标题"
            aria-label="页面标题"
          />
          <Input
            value={draft.path}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
            placeholder="路径，用斜杠分层，例如 runbooks/deploy。留空则用标题"
            aria-label="页面路径"
            className="font-mono text-xs"
          />
          <Textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder="正文（markdown）"
            aria-label="页面正文"
            className="min-h-32"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!draft.title.trim() || createPage.isPending}
              onClick={() => createPage.mutate({ ...draft, path: draft.path.trim() || draft.title.trim() })}
            >
              <Save className="h-4 w-4" aria-hidden /> 保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              <X className="h-4 w-4" aria-hidden /> 取消
            </Button>
          </div>
        </div>
      ) : null}

      {pagesQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">加载中…</p>
      ) : pages.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {query
            ? `没有匹配「${query}」的页面。`
            : space === "agent"
              ? "还没有页面。写 Agent 真正会消费的内容：可执行步骤、判定条件、边界、反例。"
              : space === "personal"
                ? "还没有登记的个人文件。CLI 执行 paperclipai personal-file register / sync 落第一版。"
                : "还没有页面。写给人看的文档：架构、接口、部署、排障，以及人要守的约定。"}
        </p>
      ) : (
        <>
        {fixedSpace ? (
          <div role="tablist" className="flex flex-wrap gap-1 border-b border-border pb-2" data-testid="personal-tool-tabs">
            {[{ id: "all", label: `全部 ${pages.length}` }].concat(
              tools.map((t) => ({ id: t, label: `${toolLabel(t)} ${pages.filter((p) => p.path.split("/")[0] === t).length}`, tool: t })),
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={toolTab === t.id}
                onClick={() => setToolTab(t.id)}
                className={`rounded-md px-3 py-1 text-sm transition-colors ${toolTab === t.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {"tool" in t && t.tool ? (
                  <ToolBrandIcon tool={t.tool as string} iconUrl={toolBrandIcons.get(t.tool as string)} />
                ) : null}
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
        {showTree ? (
          // -mx-6 undoes the header's gutter so the rail sits flush against the
          // app sidebar; min-h-0 lets the rail and the body scroll separately.
          <div className="-mx-6 flex min-h-0 flex-1 border-t border-border">
            <WikiTreeBrowser
              key={`${selectedCompanyId ?? "none"}:${isArchive ? "archived" : space}`}
              pages={pages}
              storageKey={expandedStorageKey}
              renderPage={renderPageCard}
              pathOf={isArchive ? archiveTreePath : undefined}
            />
          </div>
        ) : (
        <div className={fixedSpace ? "" : "flex flex-col gap-6 sm:flex-row"}>
        {fixedSpace ? null : (
          <nav className="sm:w-44 sm:shrink-0" aria-label="目录" data-testid="wiki-dir-nav">
            <p className="mb-1 px-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">目录</p>
            <ul className="space-y-0.5">
              {[
                { id: "all", label: `全部 ${visiblePages.length}` },
                ...(rootPages.length > 0 ? [{ id: "__root__", label: `未分组 ${rootPages.length}` }] : []),
                ...dirGroups.map((dir) => ({ id: dir, label: `${dir} ${visiblePages.filter((p) => p.path.split("/")[0] === dir).length}` })),
              ].map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={dirTab === item.id}
                    onClick={() => setDirTab(item.id)}
                    className={`w-full rounded-md px-2 py-1 text-left text-sm transition-colors ${dirTab === item.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"}`}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <ul className={fixedSpace ? "space-y-3" : "min-w-0 flex-1 space-y-3"}>
          {filteredPages.map((page) => (
            <li key={page.id} className="rounded-lg border border-border p-4">
              {renderPageCard(page)}
            </li>
          ))}
        </ul>
        </div>
        )}
        </>
      )}
    </div>
  );
}

function PageVersions({
  companyId,
  space,
  pageId,
  agentNames,
  onRestored,
}: {
  companyId: string | null;
  space: Space;
  pageId: string;
  agentNames: Map<string, string>;
  onRestored: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [diffOpen, setDiffOpen] = useState(false);
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);

  const versionsQuery = useQuery({
    queryKey: versionsKey(companyId, pageId),
    queryFn: () =>
      api.get<TeamWikiPageVersion[]>(`/companies/${companyId}/team-wiki/${space}/pages/${pageId}/versions`),
    enabled: Boolean(companyId),
  });

  const restore = useMutation({
    mutationFn: (revisionNumber: number) =>
      api.post(`/companies/${companyId}/team-wiki/${space}/pages/${pageId}/versions/${revisionNumber}/restore`, {}),
    onSuccess: () => {
      onRestored();
      queryClient.invalidateQueries({ queryKey: versionsKey(companyId, pageId) });
    },
    onError: (error: Error) => pushToast({ title: "回滚失败", body: error.message, tone: "error" }),
  });

  // The API already returns newest-first; sorting here keeps the component
  // correct if that ever changes, since every index below assumes it.
  const versions = useMemo(
    () => [...(versionsQuery.data ?? [])].sort((a, b) => b.revisionNumber - a.revisionNumber),
    [versionsQuery.data],
  );

  function openDiff(targetId?: string) {
    const selection = revisionDiffSelection(versions, targetId);
    setLeftId(selection.leftId);
    setRightId(selection.rightId);
    setDiffOpen(true);
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {versionsQuery.isLoading ? "加载版本…" : `${versions.length} 个版本`}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => openDiff()} disabled={versions.length < 2}>
          <History className="mr-1.5 h-3.5 w-3.5" aria-hidden /> 对比
        </Button>
      </div>
      <div className="mt-2 border-t border-border">
        {versions.length === 0 && !versionsQuery.isLoading ? (
          <p className="py-4 text-xs text-muted-foreground">还没有保存过版本。</p>
        ) : (
          versions.map((version, index) => (
            <div
              key={version.id}
              className="flex items-center justify-between gap-2 border-b border-border py-2.5 text-sm last:border-b-0"
            >
              <div className="min-w-0">
                <div className="text-xs font-medium">
                  {revisionLabel(version)}
                  {index === 0 ? <span className="ml-2 text-muted-foreground">当前</span> : null}
                </div>
                <div className={cn("mt-0.5 text-(length:--text-micro) text-muted-foreground")}>
                  {relativeTime(version.createdAt)}
                  {authorLabel(version.authorAgentId, agentNames)
                    ? ` · ${authorLabel(version.authorAgentId, agentNames)}`
                    : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* The newest revision already is the live page, so restoring it
                    would only append an identical version. */}
                {index === 0 ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`回滚到 v${version.revisionNumber}`}
                    title={`回滚到 v${version.revisionNumber}`}
                    disabled={restore.isPending}
                    onClick={() => {
                      if (window.confirm(`把这个页面回滚到 v${version.revisionNumber}？当前内容会另存为新版本。`)) {
                        restore.mutate(version.revisionNumber);
                      }
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={versions.length < 2}
                  onClick={() => openDiff(version.id)}
                >
                  查看差异
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
      <RevisionDiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title="差异 · Team Wiki"
        revisions={versions}
        leftId={leftId}
        rightId={rightId}
        onLeftChange={setLeftId}
        onRightChange={setRightId}
      />
    </div>
  );
}

function PageEditor({
  page,
  onSave,
  onCancel,
  pending,
}: {
  page: TeamWikiPage;
  onSave: (title: string, path: string, body: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState(page.title);
  const [path, setPath] = useState(page.path);
  const [body, setBody] = useState(page.body);
  return (
    <div className="space-y-2">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="页面标题" />
      <Input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        aria-label="页面路径"
        className="font-mono text-xs"
      />
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="页面正文" className="min-h-32" />
      <div className="flex gap-2">
        <Button size="sm" disabled={!title.trim() || !path.trim() || pending} onClick={() => onSave(title, path, body)}>
          <Save className="h-4 w-4" aria-hidden /> 保存
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-4 w-4" aria-hidden /> 取消
        </Button>
      </div>
    </div>
  );
}
