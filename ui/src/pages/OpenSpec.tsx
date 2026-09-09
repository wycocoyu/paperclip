import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { OPENSPEC_PATH_PARAM } from "@/lib/openspec-links";
import { FileText } from "lucide-react";
import { api } from "@/api/client";
import { useCompany } from "@/context/CompanyContext";
import { MarkdownBody } from "@/components/MarkdownBody";
import { FileTree, buildFileTree, collectAllPaths } from "@/components/FileTree";
import { useResizableRail } from "@/hooks/useResizableRail";

type OpenSpecFile = { path: string; size: number; modifiedAt: string };
type OpenSpecListing = { root: string; available: boolean; files: OpenSpecFile[] };

const EXPANDED_STORAGE_PREFIX = "paperclip:openspec:expanded";

function readExpandedDirs(storageKey: string, fallback: Iterable<string>): Set<string> {
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
 * YAML has no markdown rendering of its own, so it is shown as a fenced code
 * block through the same renderer rather than pulling in a second one.
 */
function asMarkdown(path: string, content: string) {
  return path.endsWith(".md") ? content : `\`\`\`yaml\n${content}\n\`\`\``;
}

/**
 * The store browsed as a file tree on the left and one file's body on the
 * right — the Team Wiki reading shape, over the git checkout on disk.
 *
 * The caller mounts this only once the listing has arrived, so the
 * expand-everything seed is computed from the real tree rather than from an
 * empty one and then resynced by an effect.
 */
function StoreTreeBrowser({ companyId, files, storageKey }: {
  companyId: string;
  files: OpenSpecFile[];
  storageKey: string;
}) {
  const nodes = useMemo(
    () => buildFileTree(Object.fromEntries(files.map((file) => [file.path, true]))),
    [files],
  );
  const filePaths = useMemo(() => [...collectAllPaths(nodes, "file")], [nodes]);
  const [expandedDirs, setExpandedDirs] = useState(() =>
    readExpandedDirs(storageKey, collectAllPaths(nodes, "dir")),
  );
  // The selected file lives in the URL, not in component state: a link to one
  // spec has to survive being shared, reloaded or linked to from an issue.
  // `replace` keeps browsing the tree from stacking one history entry per
  // click — Back should leave the page, not walk back through every file.
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPath = searchParams.get(OPENSPEC_PATH_PARAM);
  const setSelectedPath = useCallback(
    (path: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(OPENSPEC_PATH_PARAM, path);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const rail = useResizableRail({ storageKey: "paperclip.openspec.railWidth" });

  // A link can name a directory rather than a file — an issue that points at a
  // whole change is the normal case, since a change is a folder. There is no
  // directory view to open, so resolve it to the file a reader wants first:
  // `proposal.md` if the change has one, otherwise whatever sorts first inside.
  const resolvedPath = useMemo(() => {
    if (!selectedPath) return null;
    if (filePaths.includes(selectedPath)) return selectedPath;
    const dirPrefix = `${selectedPath.replace(/\/+$/, "")}/`;
    const inside = filePaths.filter((path) => path.startsWith(dirPrefix));
    if (inside.length === 0) return null;
    return (
      inside.find((path) => path === `${dirPrefix}proposal.md`)
      ?? inside.slice().sort()[0]
    );
  }, [selectedPath, filePaths]);

  // A refetch — or a link pointing at something since renamed or archived —
  // can retire the requested path, so fall back to the first file instead of
  // leaving the reading pane blank.
  const activePath = resolvedPath ?? (filePaths[0] ?? null);
  // Only a path that resolves to nothing at all is "missing". A directory that
  // resolved to a file inside it did what the link asked for, so it gets no
  // warning.
  const requestedButMissing = Boolean(selectedPath) && resolvedPath === null;

  const fileQuery = useQuery({
    queryKey: ["openspec", "file", companyId, activePath],
    queryFn: () =>
      api.get<{ path: string; content: string; modifiedAt: string }>(
        `/companies/${companyId}/openspec/file?path=${encodeURIComponent(activePath!)}`,
      ),
    enabled: Boolean(activePath),
  });

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
        data-testid="openspec-dir-nav"
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
          wrapLabels={false}
          ariaLabel="OpenSpec 目录"
          empty={{ title: "仓里还没有文件" }}
        />
        {/* 手柄压在 rail 右缘上，`relative` 由 nav 自己提供。before 伪元素画那条
            一像素的线，只在悬停、聚焦或拖动时显形，静止时不给页面加视觉噪音。 */}
        <div
          {...rail.handleProps}
          data-testid="openspec-rail-handle"
          className={`absolute inset-y-0 right-0 z-20 hidden w-3 cursor-col-resize touch-none outline-none sm:block
            before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors
            hover:before:bg-border focus-visible:before:bg-ring ${rail.isResizing ? "before:bg-ring" : ""}`}
        />
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5" data-testid="openspec-file-pane">
        {activePath ? (
          <div className="w-full space-y-3">
            {requestedButMissing ? (
              <p
                className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                data-testid="openspec-missing-path"
              >
                链接指向的 <code>{selectedPath}</code> 不在仓里了（改名或已归档），下面显示的是第一个文件。
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{activePath}</p>
            {fileQuery.data ? (
              <MarkdownBody>{asMarkdown(activePath, fileQuery.data.content)}</MarkdownBody>
            ) : (
              <p className="text-xs text-muted-foreground">{fileQuery.isError ? "读取失败。" : "读取中…"}</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">从左侧目录选一个文件。</p>
        )}
      </div>
    </div>
  );
}

/**
 * A read-only view of the openspec planning store. The git checkout on the
 * server is the source of truth — nothing is copied or mirrored here, so a
 * `git pull` on that checkout is all it takes to update this tab.
 */
export function OpenSpec() {
  const { selectedCompanyId } = useCompany();

  const listingQuery = useQuery({
    queryKey: ["openspec", "files", selectedCompanyId],
    queryFn: () => api.get<OpenSpecListing>(`/companies/${selectedCompanyId}/openspec/files`),
    enabled: Boolean(selectedCompanyId),
  });

  return (
    // The rail has to reach the app sidebar, so this cancels <main>'s padding
    // the way Team Wiki does.
    <div className="-m-4 flex min-h-0 flex-col space-y-4 px-6 pt-5 sm:h-full md:-m-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <FileText className="h-5 w-5 text-sky-600 dark:text-sky-400" aria-hidden /> OpenSpec
        </h1>
        <p className="text-sm text-muted-foreground">
          openspec 规划仓的只读视图：累积规格与进行中的变更，直接读服务端的 git 检出。
        </p>
      </header>

      {listingQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">读取中…</p>
      ) : listingQuery.data && !listingQuery.data.available ? (
        <div
          className="rounded-md border border-border p-4 text-sm text-muted-foreground"
          data-testid="openspec-unavailable"
        >
          没找到 openspec 仓。服务端读取路径：<code className="ml-1">{listingQuery.data.root}</code>
        </div>
      ) : (
        // -mx-6 undoes the header's gutter so the rail sits flush against the
        // app sidebar; min-h-0 lets the rail and the body scroll separately.
        <div className="-mx-6 flex min-h-0 flex-1 border-t border-border">
          <StoreTreeBrowser
            companyId={selectedCompanyId ?? ""}
            files={listingQuery.data?.files ?? []}
            storageKey={`${EXPANDED_STORAGE_PREFIX}:${selectedCompanyId ?? "global"}`}
          />
        </div>
      )}
    </div>
  );
}
