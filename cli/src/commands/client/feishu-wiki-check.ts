import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN,
  isFeishuIssueWikiLink,
} from "@paperclipai/shared";

const execFileAsync = promisify(execFile);

export type LarkCliRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: LarkCliRunner = (file, args) =>
  execFileAsync(file, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const INSTALL_HINT =
  "装 lark-cli 并登录（lark-cli auth login --as user），或改走卡内文档通路：issue document:put <卡> requirements / tech-proposal";

/** 技术方案子页的判定：标题含「技术方案」。子页可能带后缀（「技术方案：附件路径改写修复」）。 */
const TECH_PROPOSAL_TITLE = "技术方案";

/** 父卡目录的判定：它下面挂的是子卡目录，标题形如「MUL-568 停止任务全链路取消」。 */
const CHILD_ISSUE_DIR_TITLE = /^MUL-\d+/;

/** 上溯祖先的层数上限：防目录成环，也防意外深树把 lark-cli 调用打爆。 */
const MAX_ANCESTOR_DEPTH = 10;

type WikiNode = {
  node_token?: string;
  obj_token?: string;
  parent_node_token?: string;
  space_id?: string;
  title?: string;
};

async function larkJson(
  runner: LarkCliRunner,
  args: string[],
): Promise<{ ok?: boolean; data?: unknown }> {
  let stdout: string;
  try {
    ({ stdout } = await runner("lark-cli", args));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`飞书 wiki 链接校验需要 lark-cli，但它不在 PATH 里。${INSTALL_HINT}`);
    }
    const detail = (err as { stderr?: string; message?: string }).stderr || (err as Error).message;
    throw new Error(`lark-cli ${args.join(" ")} 执行失败：${String(detail).trim()}\n${INSTALL_HINT}`);
  }
  let parsed: { ok?: boolean; data?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new Error(`lark-cli ${args.join(" ")} 返回的不是 JSON：${stdout.slice(0, 200)}`);
  }
  if (parsed.ok === false) {
    throw new Error(`lark-cli ${args.join(" ")} 返回失败：${JSON.stringify(parsed.error ?? parsed)}`);
  }
  return parsed;
}

/** metadata 里的声明字段：缺就按飞书里查到的真实值补上，填了却对不上就报错，不静默覆盖。 */
function assertDeclared(
  payload: { metadata?: Record<string, unknown> | null },
  field: "rootNodeToken" | "parentNodeToken",
  actual: string,
): void {
  const declared = payload.metadata?.[field];
  if (declared === undefined || declared === null || declared === "") {
    payload.metadata = { ...(payload.metadata ?? {}), [field]: actual };
    return;
  }
  if (declared !== actual) {
    throw new Error(
      `payload 里 metadata.${field} 写的是 ${String(declared)}，但飞书里查到的是 ${actual}。`
      + "服务端门禁认的是 metadata 这个声明，改对再挂。",
    );
  }
}

/**
 * 沿 parent_node_token 逐级上溯，确认这个节点在固定页的子树里。
 *
 * 目录树跟卡树同构后是多层的（固定页 → 父卡目录 → 子卡目录），只看直接父节点会把子卡目录判错。
 */
async function assertUnderIssueWikiRoot(
  runner: LarkCliRunner,
  node: WikiNode,
  url: string,
): Promise<void> {
  let current = node;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const parent = current.parent_node_token;
    if (parent === FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN) return;
    if (!parent) {
      throw new Error(
        `这个 wiki 节点（${node.title ?? url}）沿目录往上走到顶层（${current.title ?? current.node_token}）`
        + `都没经过固定页「需求 issue 区」（${FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN}）。`
        + "把本卡目录移到那一页下面，或移到那一页下的父卡目录里。",
      );
    }
    const ancestor = (await larkJson(runner, [
      "wiki", "+node-get", "--node-token", parent, "--as", "user", "--format", "json",
    ])).data as WikiNode | undefined;
    if (!ancestor?.node_token) {
      throw new Error(`往上找祖先节点 ${parent} 时读不到它，无法确认 ${url} 在不在固定页下。`);
    }
    current = ancestor;
  }
  throw new Error(
    `这个 wiki 节点（${node.title ?? url}）往上走了 ${MAX_ANCESTOR_DEPTH} 层还没到固定页`
    + `「需求 issue 区」（${FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN}），判定为目录层级异常或成环，不再上溯。`,
  );
}

/**
 * 创建飞书 wiki work product 前的真伪校验（MUL-603）。
 *
 * 服务端收卡门禁只看得见这条链接的存在，看不见飞书里的正文，所以「这链接是不是
 * 真挂在固定页下」「有没有技术方案页」「那页有没有验证证据」三问在创建这一刻问完。
 * 三个判据任一不过就不创建——否则门禁会放行一条指向空目录的链接。
 */
export async function assertFeishuIssueWikiWorkProduct(
  payload: { type?: string | null; url?: string | null; metadata?: Record<string, unknown> | null },
  runner: LarkCliRunner = defaultRunner,
): Promise<void> {
  if (!isFeishuIssueWikiLink(payload)) return;
  const url = payload.url ?? "";

  const node = (await larkJson(runner, [
    "wiki", "+node-get", "--node-token", url, "--as", "user", "--format", "json",
  ])).data as WikiNode | undefined;
  if (!node?.node_token) {
    throw new Error(`飞书 wiki 节点不存在或读不到：${url}`);
  }
  await assertUnderIssueWikiRoot(runner, node, url);

  // 这里问的是飞书里的真实层级，而服务端收卡门禁只看得见 metadata 里的声明字段。
  // 两边查的不是同一样东西，所以缺声明时按刚查到的真实值补上，免得链接挂上了门禁却不认；
  // 声明了却跟真实值对不上就报错，不静默覆盖调用方写的值。
  // rootNodeToken 是门禁现在认的那一条（节点在固定页子树里），parentNodeToken 记真实直接父节点。
  assertDeclared(payload, "rootNodeToken", FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN);
  assertDeclared(payload, "parentNodeToken", String(node.parent_node_token ?? ""));

  const children = ((await larkJson(runner, [
    "wiki", "+node-list", "--space-id", String(node.space_id ?? ""),
    "--parent-node-token", String(node.node_token), "--as", "user", "--format", "json",
  ])).data as { nodes?: WikiNode[] } | undefined)?.nodes ?? [];
  // 父卡目录只放子卡索引，没有需求设计与技术方案，下面两问对它不成立（目录树跟卡树同构）。
  if (children.some((child) => CHILD_ISSUE_DIR_TITLE.test((child.title ?? "").trim()))) return;

  const techProposal = children.find((child) => (child.title ?? "").includes(TECH_PROPOSAL_TITLE));
  if (!techProposal?.obj_token) {
    throw new Error(
      `本卡子目录「${node.title ?? url}」下没有标题含「${TECH_PROPOSAL_TITLE}」的子页`
      + `（现有子页：${children.map((c) => c.title ?? "?").join("、") || "无"}）。先建技术方案页再挂链接。`,
    );
  }

  // --doc-format markdown 是必须的：默认的 xml 格式把代码块渲染成 <code> 标签，
  // ``` 围栏一个都不会出现，下面的判据会恒假。
  const content = ((await larkJson(runner, [
    "docs", "+fetch", "--doc", String(techProposal.obj_token), "--as", "user", "--doc-format", "markdown",
  ])).data as { document?: { content?: string } } | undefined)?.document?.content ?? "";

  // 判据与服务端门禁 A（MUL-558）逐字相同，见 server/src/services/issue-prerequisites.ts：
  // 走 wiki 通路的卡服务端读不到正文，这一半的检查挪到了这里。只判在不在，不判真假。
  const hasCommandBlock = content.includes("```");
  const mentionsVerification = /验证|verification/i.test(content);
  if (!hasCommandBlock || !mentionsVerification) {
    throw new Error(
      `技术方案页「${techProposal.title}」缺验证证据——正文须含「验证」字样与至少一个命令/输出代码块`
      + "（只判在不在，不判真假）。补「验证方式」节并贴命令输出再挂链接。",
    );
  }
}
