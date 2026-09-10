import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AgentIcon } from "@/components/AgentIconPicker";
import { copyTextToClipboard } from "@/lib/clipboard";
import { sessionCopyText } from "@/lib/session-resume";
import { t } from "@/i18n";
import { cn } from "../../lib/utils";

export function PropertySection({
  children,
  className,
  title,
  first,
}: {
  children: ReactNode;
  className?: string;
  /** Labeled section header (§4). When set, renders the uppercase header above the rows. */
  title?: string;
  /** First section drops the top padding on its header. */
  first?: boolean;
}) {
  return (
    <div className={className}>
      {title ? (
        <div
          className={cn(
            "text-xs font-semibold uppercase tracking-wide text-muted-foreground pb-1",
            first ? "pt-0" : "pt-3",
          )}
        >
          {title}
        </div>
      ) : null}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export function PropertyRow({
  label,
  children,
  wrap,
}: {
  label: ReactNode;
  children: ReactNode;
  /** Opt-in wrapping for chip-collection rows only (§5). Default rows stay one line. */
  wrap?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 gap-3 py-1",
        wrap ? "items-start" : "items-center",
      )}
      data-property-row="true"
    >
      <span
        className={cn(
          "text-xs text-muted-foreground shrink-0 w-24 truncate",
          wrap && "mt-0.5",
        )}
        data-property-label={typeof label === "string" ? label : undefined}
        title={typeof label === "string" ? label : undefined}
      >
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function PropertyChip({
  children,
  className,
  style,
  title,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Tooltip override for chips whose children are not a bare string. */
  title?: string;
}) {
  return (
    <Badge
      variant="outline"
      // Badge chassis; keep this chip's truncation + normal weight + start alignment.
      className={cn("max-w-full min-w-0 justify-start truncate font-normal", className)}
      style={style}
      title={title ?? (typeof children === "string" ? children : undefined)}
    >
      {children}
    </Badge>
  );
}

/**
 * A session row: who it was, then the session id. The id alone identifies a
 * session but not a participant — two ids side by side are indistinguishable
 * to a reader, so the name carries recognition and the id carries traceability.
 *
 * Cards are usually opened by a terminal agent rather than a person, so the
 * agent branch is the common case, not the fallback.
 */
export function SessionIdentity({
  agentId,
  agentName,
  agentIcon,
  agentCustomIconUrl,
  agentAdapterType,
  userId,
  sessionId,
  shortSessionId,
  unattributedLabel,
  tag,
  live,
}: {
  agentId: string | null;
  agentName: string | null;
  agentIcon?: string | null;
  agentCustomIconUrl?: string | null;
  /** Decides which CLI's resume command the id copies as (see SessionIdChip). */
  agentAdapterType?: string | null;
  userId: string | null;
  sessionId: string | null;
  /** Lists show the id abbreviated; the full one stays in the chip's tooltip. */
  shortSessionId?: boolean;
  /** Shown in place of the name when the row has neither agent nor user. */
  unattributedLabel?: string;
  tag?: string;
  live?: boolean;
}) {
  const label = agentId ? (agentName ?? agentId.slice(0, 8)) : userId ?? unattributedLabel ?? null;
  if (!label && !sessionId) {
    return <span className="text-sm text-muted-foreground">{t("Unknown")}</span>;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {label && (
        <span className="flex min-w-0 items-center gap-1.5">
          {agentId ? (
            <AgentIcon icon={agentIcon} customIconUrl={agentCustomIconUrl} className="h-3.5 w-3.5 shrink-0" />
          ) : null}
          {/* 认不出来的行不装成一个名字：文案压成次要色。 */}
          <span className={cn("truncate text-sm", !agentId && !userId && "text-muted-foreground")}>{label}</span>
        </span>
      )}
      {sessionId && (
        <SessionIdChip
          sessionId={sessionId}
          agentName={agentName}
          agentAdapterType={agentAdapterType}
          shorten={shortSessionId}
        />
      )}
      {tag && (
        <span className="shrink-0 rounded-full border border-border px-1.5 text-(length:--text-micro) text-muted-foreground">
          {tag}
        </span>
      )}
      {live && (
        <span className="flex shrink-0 items-center gap-1 text-(length:--text-micro) text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
          {t("Running")}
        </span>
      )}
    </div>
  );
}

/**
 * The session id, clickable. A recorded session is only useful if you can
 * reopen it, and the id alone is half the command — so for the CLIs whose
 * resume syntax we know (Claude, Codex) the click copies the whole line
 * (`claude --resume <id>`) instead of the bare id. Everything else copies the
 * id, which is still what a reader wants from it.
 */
function SessionIdChip({
  sessionId,
  agentName,
  agentAdapterType,
  shorten,
}: {
  sessionId: string;
  agentName: string | null;
  agentAdapterType?: string | null;
  shorten?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copyText = sessionCopyText({ adapterType: agentAdapterType, agentName, sessionId });

  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(copyText);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked; leave the id on screen to copy by hand */ }
  }, [copyText]);

  return (
    <span className="flex min-w-0 max-w-full items-center gap-1">
      <button
        type="button"
        onClick={handleCopy}
        /* The tooltip is the copy text itself, so the resume command is
           readable before the click, not only after pasting it. */
        title={copyText}
        aria-label={`Copy ${copyText} to clipboard`}
        className="max-w-full cursor-pointer break-all rounded-sm border border-border bg-muted/40 px-1.5 text-left font-mono text-(length:--text-micro) text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      >
        {shorten ? sessionId.slice(0, 8) : sessionId}
      </button>
      {copied && (
        <span className="flex shrink-0 items-center gap-1 text-(length:--text-micro) text-emerald-600 dark:text-emerald-400" role="status">
          <Check className="h-3 w-3 shrink-0" />
          Copied
        </span>
      )}
    </span>
  );
}

/**
 * A pull request work product. `status` (is it still open) and `reviewState`
 * (what did review conclude) are separate chips on purpose — a PR can be open
 * *and* have changes requested, and collapsing them to one word drops half of
 * that.
 */
export function PullRequestValue({ workProduct }: { workProduct: IssueWorkProduct }) {
  const number = workProduct.externalId ? `#${workProduct.externalId}` : workProduct.title;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {workProduct.url ? (
        <a
          href={workProduct.url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-sm font-medium text-primary hover:underline"
        >
          {number}
        </a>
      ) : (
        <span className="truncate text-sm font-medium">{number}</span>
      )}
      {workProduct.status && (
        <span className="shrink-0 rounded-full border border-border px-1.5 text-(length:--text-micro) text-muted-foreground">
          {workProduct.status}
        </span>
      )}
      {workProduct.reviewState && workProduct.reviewState !== "none" && (
        <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-(length:--text-micro) text-amber-700 dark:text-amber-300">
          {workProduct.reviewState.replaceAll("_", " ")}
        </span>
      )}
    </div>
  );
}
