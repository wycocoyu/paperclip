import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

/**
 * The three write-time gates that replaced Team Rules prose (MUL-555).
 *
 * Each one exists because a rule written in Chinese in Team Rules could be
 * skipped without anything noticing: claim printed no title so a guessed card
 * number landed silently (MUL-98), claim on a finished card flipped it back to
 * in_progress, and preflight only ran when someone remembered to type it.
 */

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "914fa626-0000-4000-8000-000000000000";
const BASE = "http://localhost:3100";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerIssueCommands(program);
  return program;
}

// claim / start / update all take the issue id directly, so no -C is passed —
// `issue start` does not even register the flag.
async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(
    [...args, "--api-base", BASE, "--api-key", "agent-token"],
    { from: "user" },
  );
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ISSUE_ID,
    identifier: "MUL-999",
    title: "把三条卡操作纪律改成门禁",
    companyId: COMPANY_ID,
    status: "todo",
    assigneeAgentId: AGENT_ID,
    drivingAgentId: AGENT_ID,
    ...overrides,
  };
}

const PREFLIGHT = {
  issueId: ISSUE_ID,
  status: "in_progress",
  blocking: [
    {
      gate: "收卡门禁",
      code: "issue_prerequisites_missing",
      detail: ["缺「需求设计」文档——issue document:put <卡> requirements --body-file 需求设计.md"],
      fix: "按每行末尾的命令逐样补齐，再推 in_review",
    },
  ],
  closeGate: { ready: false, missing: ["requirements"] },
  claimGate: { claimed: true, blocksThisActor: false },
  adjudicationGate: { mode: "auto", canSelfClose: true },
  reviewPathGate: { ready: true, blocksThisActor: false },
  startGate: { started: false, workingBranch: null },
  coverage: "只覆盖四道门禁",
};

function routingFetch(routes: Record<string, unknown>) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const route = routes[`${method} ${url}`];
    if (route !== undefined) return Promise.resolve(jsonResponse(route));
    if (method === "GET") return Promise.resolve(jsonResponse(null, { status: 404 }));
    return Promise.resolve(jsonResponse({ ok: true }));
  });
}

function methodsOf(fetchMock: ReturnType<typeof routingFetch>): Array<readonly [string, string]> {
  return fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]] as const);
}

/** Every PATCH body the command sent, parsed. */
function patchBodies(fetchMock: ReturnType<typeof routingFetch>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => (call[1]?.method ?? "GET") === "PATCH")
    .map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as Record<string, unknown>);
}

describe("MUL-555 · claim / start 回显卡标题", () => {
  let logged: string[];
  let errored: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    logged = [];
    errored = [];
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errored.push(a.join(" ")));
  });

  afterEach(() => vi.restoreAllMocks());

  it("claim 把卡标题打进 stdout 和开场留痕，接错卡当场看得见", async () => {
    const fetchMock = routingFetch({
      [`GET ${BASE}/api/issues/MUL-999`]: issue(),
      [`GET ${BASE}/api/agents/me`]: { id: AGENT_ID },
      [`GET ${BASE}/api/issues/${ISSUE_ID}/preflight`]: PREFLIGHT,
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "claim", "MUL-999"]);

    expect(logged.join("\n")).toContain("把三条卡操作纪律改成门禁");
    const commentBody = fetchMock.mock.calls
      .filter((call) => String(call[0]).endsWith("/comments"))
      .map((call) => String(JSON.parse(String(call[1]?.body ?? "{}")).body))
      .join("\n");
    expect(commentBody).toContain("把三条卡操作纪律改成门禁");
  });

  it("start 同样回显卡标题", async () => {
    const fetchMock = routingFetch({
      [`GET ${BASE}/api/issues/MUL-999`]: issue({ status: "in_progress" }),
      [`GET ${BASE}/api/agents/me`]: { id: AGENT_ID },
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "start", "MUL-999", "--branch", "feature/wy/MUL-999/x", "--session", "s-1"]);

    expect(logged.join("\n")).toContain("把三条卡操作纪律改成门禁");
  });
});

describe("MUL-555 · 终态卡写保护", () => {
  let errored: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    errored = [];
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errored.push(a.join(" ")));
  });

  afterEach(() => vi.restoreAllMocks());

  for (const status of ["done", "cancelled"]) {
    it(`claim 撞上 ${status} 卡时中止，不改状态，并给出修法命令`, async () => {
      const fetchMock = routingFetch({ [`GET ${BASE}/api/issues/MUL-999`]: issue({ status }) });
      vi.stubGlobal("fetch", fetchMock);

      await expect(run(["issue", "claim", "MUL-999"])).rejects.toThrowError(/process\.exit/);

      const message = errored.join("\n");
      expect(message).toContain("issue_invalid_state_transition");
      expect(message).toContain("issue update MUL-999 --status todo");
      expect(message).toContain("--force");
      // 一个 PATCH 都不许发出去：状态被推回 in_progress 就已经不可逆了
      expect(methodsOf(fetchMock).filter(([method]) => method === "PATCH")).toEqual([]);
    });

    it(`start 撞上 ${status} 卡时同样中止`, async () => {
      const fetchMock = routingFetch({ [`GET ${BASE}/api/issues/MUL-999`]: issue({ status }) });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        run(["issue", "start", "MUL-999", "--branch", "feature/wy/MUL-999/x"]),
      ).rejects.toThrowError(/process\.exit/);
      expect(methodsOf(fetchMock).filter(([method]) => method === "PATCH")).toEqual([]);
    });
  }

  it("--force 是逃生门：明说要强推就放行", async () => {
    const fetchMock = routingFetch({
      [`GET ${BASE}/api/issues/MUL-999`]: issue({ status: "done" }),
      [`GET ${BASE}/api/agents/me`]: { id: AGENT_ID },
      [`GET ${BASE}/api/issues/${ISSUE_ID}/preflight`]: PREFLIGHT,
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "claim", "MUL-999", "--force"]);

    expect(patchBodies(fetchMock).some((body) => body.status === "in_progress")).toBe(true);
  });

  it("开放态的卡不受影响", async () => {
    const fetchMock = routingFetch({
      [`GET ${BASE}/api/issues/MUL-999`]: issue({ status: "backlog" }),
      [`GET ${BASE}/api/agents/me`]: { id: AGENT_ID },
      [`GET ${BASE}/api/issues/${ISSUE_ID}/preflight`]: PREFLIGHT,
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "claim", "MUL-999"]);

    expect(patchBodies(fetchMock).some((body) => body.status === "in_progress")).toBe(true);
  });
});

describe("MUL-555 · preflight 内联到 issue update --status", () => {
  let errored: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    errored = [];
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errored.push(a.join(" ")));
  });

  afterEach(() => vi.restoreAllMocks());

  for (const status of ["in_review", "done"]) {
    it(`推 ${status} 时不用记得跑 preflight，门禁清单自己出现`, async () => {
      const fetchMock = routingFetch({
        [`GET ${BASE}/api/issues/${ISSUE_ID}`]: issue({ status: "in_progress" }),
        [`GET ${BASE}/api/issues/${ISSUE_ID}/preflight`]: PREFLIGHT,
        [`PATCH ${BASE}/api/issues/${ISSUE_ID}`]: issue({ status }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await run(["issue", "update", ISSUE_ID, "--status", status]);

      expect(methodsOf(fetchMock)).toContainEqual(["GET", `${BASE}/api/issues/${ISSUE_ID}/preflight`]);
      expect(errored.join("\n")).toContain("issue_prerequisites_missing");
    });
  }

  it("推别的状态不打扰，也不多花一次请求", async () => {
    const fetchMock = routingFetch({
      [`GET ${BASE}/api/issues/${ISSUE_ID}`]: issue({ status: "todo" }),
      [`PATCH ${BASE}/api/issues/${ISSUE_ID}`]: issue({ status: "in_progress" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "update", ISSUE_ID, "--status", "in_progress"]);

    expect(methodsOf(fetchMock)).not.toContainEqual(["GET", `${BASE}/api/issues/${ISSUE_ID}/preflight`]);
  });

  it("--json 下不掺入教学文本，机器消费者拿到的还是纯 JSON", async () => {
    const fetchMock = routingFetch({
      [`GET ${BASE}/api/issues/${ISSUE_ID}`]: issue({ status: "in_progress" }),
      [`GET ${BASE}/api/issues/${ISSUE_ID}/preflight`]: PREFLIGHT,
      [`PATCH ${BASE}/api/issues/${ISSUE_ID}`]: issue({ status: "in_review" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "update", ISSUE_ID, "--status", "in_review", "--json"]);

    expect(methodsOf(fetchMock)).not.toContainEqual(["GET", `${BASE}/api/issues/${ISSUE_ID}/preflight`]);
  });
});

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

describe("MUL-558 · start 无 session 也必须登记分支", () => {
  let logged: string[];
  let errored: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    logged = [];
    errored = [];
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_SESSION_ID;
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errored.push(a.join(" ")));
  });

  afterEach(() => vi.restoreAllMocks());

  it("Zcode/Qoder 不发布 session，start 仍要把 workingBranch 写进卡（代码卡门禁的信号源）", async () => {
    const fetchMock = routingFetch({
      [`GET ${BASE}/api/issues/MUL-999`]: issue({ status: "in_progress" }),
      [`GET ${BASE}/api/agents/me`]: { id: AGENT_ID },
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "start", "MUL-999", "--branch", "feature/wy/MUL-999/x"]);

    const patches = patchBodies(fetchMock);
    expect(patches.some((b) => b.workingBranch === "feature/wy/MUL-999/x")).toBe(true);
  });
});
