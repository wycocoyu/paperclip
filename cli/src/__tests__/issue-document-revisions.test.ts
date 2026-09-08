import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

const AGENT_ID = "b3fba255-e89e-42d9-9fc9-5aec906bdc88";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerIssueCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(
    [...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"],
    { from: "user" },
  );
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

function revision(revisionNumber: number, body: string, changeSummary: string | null = null) {
  return {
    id: `rev-${revisionNumber}`,
    revisionNumber,
    title: "技术方案",
    format: "markdown",
    body,
    changeSummary,
    createdByAgentId: AGENT_ID,
    createdByUserId: null,
    createdAt: `2026-09-0${revisionNumber}T01:02:03.000Z`,
  };
}

/** 版本按 revisionNumber 倒序返回，和服务端一致。 */
function routeFetch(revisions: unknown[]) {
  return vi.fn().mockImplementation((input: string | URL | Request) => {
    const url = String(input);
    // MUL-N 卡号原样进 path，由服务端解析。
    if (url.endsWith("/api/issues/MUL-559/documents/tech-proposal/revisions")) {
      return Promise.resolve(jsonResponse(revisions));
    }
    if (url.endsWith(`/api/agents/${AGENT_ID}`)) {
      return Promise.resolve(jsonResponse({ id: AGENT_ID, name: "Claude（Terminal）" }));
    }
    return Promise.resolve(jsonResponse({ error: "Not found" }, { status: 404 }));
  });
}

describe("issue document:revisions", () => {
  let logs: string[];
  let stdout: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    logs = [];
    stdout = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("列版本时给出版本号、时间、字符数和作者名，不打印正文", async () => {
    vi.stubGlobal("fetch", routeFetch([revision(2, "second body", "补了一段"), revision(1, "one")]));

    await run(["issue", "document:revisions", "MUL-559", "tech-proposal"]);

    expect(logs[0]).toBe("tech-proposal · 2 版");
    expect(logs[1]).toBe("  r2  2026-09-02T01:02:03.000Z  11 字  Claude（Terminal）  rev-2");
    expect(logs[2]).toBe("      补了一段");
    expect(logs[3]).toBe("  r1  2026-09-01T01:02:03.000Z  3 字  Claude（Terminal）  rev-1");
    expect(logs.join("\n")).not.toContain("second body");
  });

  it("--rev 逐字节写出该版正文，不补换行", async () => {
    vi.stubGlobal("fetch", routeFetch([revision(2, "second body"), revision(1, "one\ntwo\n")]));

    await run(["issue", "document:revisions", "MUL-559", "tech-proposal", "--rev", "1"]);

    expect(stdout.join("")).toBe("one\ntwo\n");
    expect(logs).toEqual([]);
  });

  it("--rev 指到不存在的版本时报现有版本，不是空输出", async () => {
    vi.stubGlobal("fetch", routeFetch([revision(2, "b"), revision(1, "a")]));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await run(["issue", "document:revisions", "MUL-559", "tech-proposal", "--rev", "9"]);

    expect(errors.join("\n")).toContain("没有第 9 版");
    expect(errors.join("\n")).toContain("现有版本：2, 1");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("空版本列表给出可读提示而不是 (empty)", async () => {
    vi.stubGlobal("fetch", routeFetch([]));

    await run(["issue", "document:revisions", "MUL-559", "tech-proposal"]);

    expect(logs.join("\n")).toContain("没有版本记录");
  });

  it("--json 原样输出服务端数组", async () => {
    const revisions = [revision(2, "b"), revision(1, "a")];
    vi.stubGlobal("fetch", routeFetch(revisions));

    await run(["issue", "document:revisions", "MUL-559", "tech-proposal", "--json"]);

    expect(JSON.parse(logs.join("\n"))).toEqual(revisions);
  });
});
