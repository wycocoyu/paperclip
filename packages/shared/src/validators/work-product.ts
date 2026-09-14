import { z } from "zod";
import { workspaceFileRefSchema } from "./workspace-file-resource.js";
import { objectWithoutDefaults } from "./partial.js";

function attachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

export const issueWorkProductTypeSchema = z.enum([
  "preview_url",
  "runtime_service",
  "pull_request",
  "branch",
  "commit",
  "artifact",
  "document",
  "openspec",
]);

export const issueWorkProductStatusSchema = z.enum([
  "active",
  "ready_for_review",
  "approved",
  "changes_requested",
  "merged",
  "closed",
  "failed",
  "archived",
  "draft",
]);

export const issueWorkProductReviewStateSchema = z.enum([
  "none",
  "needs_board_review",
  "approved",
  "changes_requested",
]);

export const attachmentArtifactWorkProductMetadataSchema = z.object({
  attachmentId: z.string().guid(),
  contentType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  contentPath: z.string().min(1),
  openPath: z.string().min(1),
  downloadPath: z.string().min(1),
  originalFilename: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  const contentPath = attachmentContentPath(value.attachmentId);
  if (value.contentPath !== contentPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contentPath"],
      message: "contentPath must point to the same-origin attachment content route",
    });
  }
  if (value.openPath !== contentPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["openPath"],
      message: "openPath must point to the same-origin attachment content route",
    });
  }
  if (value.downloadPath !== `${contentPath}?download=1`) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["downloadPath"],
      message: "downloadPath must point to the same-origin attachment download route",
    });
  }
});

export type AttachmentArtifactWorkProductMetadata = z.infer<typeof attachmentArtifactWorkProductMetadataSchema>;

export const issueWorkProductMetadataSchema = z
  .object({
    resourceRef: workspaceFileRefSchema.optional().nullable(),
  })
  .passthrough();

export type IssueWorkProductMetadata = z.infer<typeof issueWorkProductMetadataSchema>;

export const createIssueWorkProductSchema = z.object({
  projectId: z.string().guid().optional().nullable(),
  executionWorkspaceId: z.string().guid().optional().nullable(),
  runtimeServiceId: z.string().guid().optional().nullable(),
  type: issueWorkProductTypeSchema,
  provider: z.string().min(1),
  externalId: z.string().optional().nullable(),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  status: issueWorkProductStatusSchema.default("active"),
  reviewState: issueWorkProductReviewStateSchema.optional().default("none"),
  isPrimary: z.boolean().optional().default(false),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]).optional().default("unknown"),
  summary: z.string().optional().nullable(),
  metadata: issueWorkProductMetadataSchema.optional().nullable(),
  createdByRunId: z.string().guid().optional().nullable(),
});

export type CreateIssueWorkProduct = z.infer<typeof createIssueWorkProductSchema>;

export const updateIssueWorkProductSchema = objectWithoutDefaults(
  createIssueWorkProductSchema,
).partial();

export type UpdateIssueWorkProduct = z.infer<typeof updateIssueWorkProductSchema>;

/**
 * 飞书知识库固定页「需求 issue 区」的 wiki 节点 token（MUL-603）。
 * 需求设计与技术方案从卡内 document 搬到飞书后，收卡门禁认这一页下面的
 * 子目录链接；别处的飞书文档不算，免得随手贴一条链接就绕开门禁。
 */
export const FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN = "TeMgwN6HiiNnR3k7ohtcWiqInMg";

export const FEISHU_ISSUE_WIKI_URL_PREFIX = "https://hellotalk.feishu.cn/wiki/";

/** 看起来是 issue 区 wiki 链接——CLI 侧真伪校验的触发条件，只看 type 与 URL 前缀。 */
export function isFeishuIssueWikiLink(input: { type?: string | null; url?: string | null }): boolean {
  return input.type === "document" && (input.url ?? "").startsWith(FEISHU_ISSUE_WIKI_URL_PREFIX);
}

/**
 * 收卡门禁认的 wiki 通路：链接对，且 metadata 声明这节点在固定页的子树里（真伪由 CLI 侧创建时校验）。
 *
 * 目录树跟卡树同构后子卡目录挂在父卡目录下，直接父节点不再是固定页，所以认的是 rootNodeToken；
 * parentNodeToken 那一支是给改判据之前落库的存量记录留的（迭代只改机制，存量不补）。
 */
export function isFeishuIssueWikiDoc(
  input: { type?: string | null; url?: string | null; metadata?: unknown },
): boolean {
  if (!isFeishuIssueWikiLink(input)) return false;
  const metadata = input.metadata as { rootNodeToken?: unknown; parentNodeToken?: unknown } | null | undefined;
  return metadata?.rootNodeToken === FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN
    || metadata?.parentNodeToken === FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN;
}
