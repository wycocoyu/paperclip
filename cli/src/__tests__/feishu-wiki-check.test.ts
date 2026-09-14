import { describe, expect, it, vi } from "vitest";
import { FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN, FEISHU_ISSUE_WIKI_URL_PREFIX } from "@paperclipai/shared";
import { assertFeishuIssueWikiWorkProduct, type LarkCliRunner } from "../commands/client/feishu-wiki-check.js";

/**
 * MUL-603 CLI 侧红绿：飞书 wiki 通路的 work product 创建前三问——节点挂在固定页下、
 * 目录里有技术方案页、那页正文有验证证据。判据与服务端门禁 A 逐字相同。
 */

const NODE_TOKEN = "Nn3ew8cFhiIlk6kBNkkcBgMYnTe";
const URL = `${FEISHU_ISSUE_WIKI_URL_PREFIX}${NODE_TOKEN}`;
const SPACE_ID = "7651814251744562371";
const TECH_OBJ_TOKEN = "BhLxdcWzFoe7e3xorgMcQoegnue";

const GOOD_BODY = "# 技术方案\n\n## 验证方式\n\n```\npnpm test\n# 17 passed\n```";

type Stubs = {
  node?: Record<string, unknown>;
  /** 祖先节点表：node_token → node，给沿 parent_node_token 上溯的那几次 +node-get 用 */
  ancestors?: Record<string, Record<string, unknown>>;
  nodes?: unknown[];
  content?: string;
};

function makeRunner(stubs: Stubs = {}): LarkCliRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const target = stubs.node ?? {
    node_token: NODE_TOKEN,
    obj_token: "V6B1dIQaOoEkkTxtI93cVOYAnhm",
    parent_node_token: FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN,
    space_id: SPACE_ID,
    title: "MUL-603 收卡门禁认飞书 wiki 链接",
  };
  const runner = (async (_file: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "+node-get") {
      const token = args[args.indexOf("--node-token") + 1];
      const node = token === URL || token === target.node_token ? target : stubs.ancestors?.[token];
      if (!node) throw new Error(`unexpected +node-get for ${token}`);
      return { stdout: JSON.stringify({ ok: true, data: node }), stderr: "" };
    }
    if (args[1] === "+node-list") {
      return { stdout: JSON.stringify({ ok: true, data: { nodes: stubs.nodes ?? [
        { node_token: "c1", obj_token: "o1", title: "需求设计" },
        { node_token: "c2", obj_token: TECH_OBJ_TOKEN, title: "技术方案" },
      ] } }), stderr: "" };
    }
    if (args[1] === "+fetch") {
      return { stdout: JSON.stringify({ ok: true, data: { document: { content: stubs.content ?? GOOD_BODY } } }), stderr: "" };
    }
    throw new Error(`unexpected lark-cli call: ${args.join(" ")}`);
  }) as LarkCliRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

describe("assertFeishuIssueWikiWorkProduct · MUL-603", () => {
  it("非 wiki 通路的 payload 一个命令都不跑", async () => {
    const runner = makeRunner();
    await assertFeishuIssueWikiWorkProduct(
      { type: "pull_request", url: "https://example.com/pr/1" },
      runner,
    );
    await assertFeishuIssueWikiWorkProduct(
      { type: "document", url: "https://hellotalk.feishu.cn/docx/X5QLd6TnRoJEX2xfeVYcIVLjnZg" },
      runner,
    );
    expect(runner.calls).toEqual([]);
  });

  it("三问全过 → 放行，且技术方案页按 markdown 格式取（xml 里没有 ``` 围栏）", async () => {
    const runner = makeRunner();
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner)).resolves.toBeUndefined();
    expect(runner.calls.map((c) => c.slice(0, 2))).toEqual([
      ["wiki", "+node-get"],
      ["wiki", "+node-list"],
      ["docs", "+fetch"],
    ]);
    expect(runner.calls[2]).toContain("--doc-format");
    expect(runner.calls[2]).toContain("markdown");
    expect(runner.calls[2]).toContain(TECH_OBJ_TOKEN);
  });

  it("整条祖先链都不经过固定页 → 拒绝创建并点名固定页 token", async () => {
    const runner = makeRunner({
      node: { node_token: NODE_TOKEN, space_id: SPACE_ID, parent_node_token: "SomeOtherParent", title: "乱放的目录" },
      ancestors: { SomeOtherParent: { node_token: "SomeOtherParent", parent_node_token: "", title: "别的顶层页" } },
    });
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner))
      .rejects.toThrow(FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN);
  });

  it("目录下没有技术方案子页 → 拒绝并列出现有子页", async () => {
    const runner = makeRunner({ nodes: [{ node_token: "c1", obj_token: "o1", title: "需求设计" }] });
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner))
      .rejects.toThrow(/技术方案.*需求设计/s);
  });

  it("技术方案页无代码块 → 拒绝（判据与服务端门禁 A 相同）", async () => {
    const runner = makeRunner({ content: "# 技术方案\n\n## 验证方式\n\n跑一遍测试。" });
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner))
      .rejects.toThrow("缺验证证据");
  });

  it("技术方案页无「验证」字样 → 拒绝", async () => {
    const runner = makeRunner({ content: "# 技术方案\n\n```\npnpm test\n```" });
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner))
      .rejects.toThrow("缺验证证据");
  });

  it("lark-cli 不在 PATH → 拒绝创建并给安装指引，不静默放行", async () => {
    const runner = vi.fn(async () => {
      const err = new Error("spawn lark-cli ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }) as unknown as LarkCliRunner;
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner))
      .rejects.toThrow(/lark-cli.*不在 PATH/s);
  });

  it("lark-cli 返回 ok:false → 拒绝创建", async () => {
    const runner = (async () => ({ stdout: JSON.stringify({ ok: false, error: { msg: "permission denied" } }), stderr: "" })) as LarkCliRunner;
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner))
      .rejects.toThrow("permission denied");
  });

  it("payload 缺 metadata.parentNodeToken → 按真实父节点补上，否则服务端门禁认不出这条链接", async () => {
    const runner = makeRunner();
    const payload: { type: string; url: string; metadata?: Record<string, unknown> | null } = { type: "document", url: URL };
    await assertFeishuIssueWikiWorkProduct(payload, runner);
    expect(payload.metadata?.parentNodeToken).toBe(FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN);
  });

  it("metadata.parentNodeToken 跟飞书真实父节点对不上 → 拒绝，不静默改写调用方的值", async () => {
    const runner = makeRunner();
    const payload = { type: "document", url: URL, metadata: { parentNodeToken: "WRONGtoken0000000000000000" } };
    await expect(assertFeishuIssueWikiWorkProduct(payload, runner))
      .rejects.toThrow("服务端门禁认的是 metadata 这个声明");
    expect(payload.metadata.parentNodeToken).toBe("WRONGtoken0000000000000000");
  });

  it("已填对的 metadata 原样保留，其余字段不丢，只补上缺的 rootNodeToken", async () => {
    const runner = makeRunner();
    const payload = {
      type: "document",
      url: URL,
      metadata: { parentNodeToken: FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN, spaceId: SPACE_ID },
    };
    await assertFeishuIssueWikiWorkProduct(payload, runner);
    expect(payload.metadata).toEqual({
      rootNodeToken: FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN,
      parentNodeToken: FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN,
      spaceId: SPACE_ID,
    });
  });
});

/**
 * MUL-603 续：飞书目录树改成跟卡树同构（固定页 → 父卡目录 → 子卡目录 → 需求设计/技术方案），
 * 于是「挂在固定页下」的语义变成「在固定页的子树里」，父卡目录那一层也不该再被要求有技术方案页。
 */
describe("assertFeishuIssueWikiWorkProduct · 卡树同构的多层目录", () => {
  const PARENT_DIR_TOKEN = "N8oowjWdZieJ4HkYCPdcbrQ4nhb";
  const parentDir = {
    node_token: PARENT_DIR_TOKEN,
    parent_node_token: FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN,
    space_id: SPACE_ID,
    title: "MUL-101 Workflow 中断与续跑能力域",
  };
  const childDirNode = {
    node_token: NODE_TOKEN,
    obj_token: "MEZ7dZxjqoqbp7xNq51c7fStnjh",
    parent_node_token: PARENT_DIR_TOKEN,
    space_id: SPACE_ID,
    title: "MUL-568 停止任务全链路取消",
  };

  it("子卡目录挂在父卡目录下 → 沿祖先链走到固定页就放行", async () => {
    const runner = makeRunner({ node: childDirNode, ancestors: { [PARENT_DIR_TOKEN]: parentDir } });
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner)).resolves.toBeUndefined();
  });

  it("子卡目录的 metadata：rootNodeToken 填固定页，parentNodeToken 填真实直接父节点", async () => {
    const runner = makeRunner({ node: childDirNode, ancestors: { [PARENT_DIR_TOKEN]: parentDir } });
    const payload: { type: string; url: string; metadata?: Record<string, unknown> | null } = { type: "document", url: URL };
    await assertFeishuIssueWikiWorkProduct(payload, runner);
    expect(payload.metadata).toEqual({
      rootNodeToken: FEISHU_ISSUE_WIKI_ROOT_NODE_TOKEN,
      parentNodeToken: PARENT_DIR_TOKEN,
    });
  });

  it("metadata.rootNodeToken 写的不是固定页 → 拒绝，不静默覆盖", async () => {
    const runner = makeRunner({ node: childDirNode, ancestors: { [PARENT_DIR_TOKEN]: parentDir } });
    const payload = { type: "document", url: URL, metadata: { rootNodeToken: "WRONGroot00000000000000000" } };
    await expect(assertFeishuIssueWikiWorkProduct(payload, runner)).rejects.toThrow("rootNodeToken");
    expect(payload.metadata.rootNodeToken).toBe("WRONGroot00000000000000000");
  });

  it("父卡目录（下面挂的是子卡目录）→ 跳过技术方案页与验证证据两问", async () => {
    const runner = makeRunner({
      node: parentDir,
      nodes: [
        { node_token: "c1", obj_token: "o1", title: "MUL-563 节点成功后提前收尾（on_success finish）" },
        { node_token: "c2", obj_token: "o2", title: "MUL-568 停止任务全链路取消" },
      ],
    });
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner)).resolves.toBeUndefined();
    // 父卡目录只有子卡索引，没有正文可读——不该再去 docs +fetch
    expect(runner.calls.map((c) => c.slice(0, 2))).toEqual([["wiki", "+node-get"], ["wiki", "+node-list"]]);
  });

  it("祖先链超过深度上限（成环或异常深树）→ 报错说明层级，不无限上溯", async () => {
    const ancestors: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 20; i += 1) {
      ancestors[`a${i}`] = { node_token: `a${i}`, parent_node_token: `a${i + 1}`, title: `第 ${i} 层` };
    }
    const runner = makeRunner({
      node: { node_token: NODE_TOKEN, space_id: SPACE_ID, parent_node_token: "a0", title: "深树里的目录" },
      ancestors,
    });
    await expect(assertFeishuIssueWikiWorkProduct({ type: "document", url: URL }, runner))
      .rejects.toThrow(/10 层/);
  });
});
