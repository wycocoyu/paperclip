import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerIssueCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

/** document:image 走的固定响应：上传 201、旧正文、已认领的卡、写入成功。 */
function routeFetch(options?: { previousBody?: string | null }) {
  return vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith(`/companies/${COMPANY_ID}/issues/${ISSUE_ID}/attachments`)) {
      return Promise.resolve(jsonResponse({
        id: "att-1",
        assetId: ASSET_ID,
        contentType: "image/png",
        originalFilename: "shot.png",
        contentPath: `/api/attachments/att-1/content`,
      }, { status: 201 }));
    }
    if (method === "GET" && url.endsWith(`/api/issues/${ISSUE_ID}/documents/notes`)) {
      if (options?.previousBody === null || options?.previousBody === undefined) {
        return Promise.resolve(jsonResponse({ error: "Not found" }, { status: 404 }));
      }
      return Promise.resolve(jsonResponse({ body: options.previousBody }));
    }
    if (method === "GET" && url === `http://localhost:3100/api/issues/${ISSUE_ID}`) {
      return Promise.resolve(jsonResponse({
        id: ISSUE_ID,
        identifier: "MUL-900",
        assigneeAgentId: "agent-1",
      }));
    }
    if (method === "PUT" && url.endsWith(`/api/issues/${ISSUE_ID}/documents/notes`)) {
      return Promise.resolve(jsonResponse({ ok: true, key: "notes" }));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
}

describe("issue document:image", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uploads the image and appends the markdown reference to an existing document", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "paperclip-cli-test-"));
    const filePath = join(tmp, "shot.png");
    await writeFile(filePath, "png", "utf8");
    const fetchMock = routeFetch({ previousBody: "原有正文\n\n" });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await run([
        "issue", "document:image", ISSUE_ID, "notes",
        "--company-id", COMPANY_ID,
        "--file", filePath,
        "--caption", "登录页",
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/issues/${ISSUE_ID}/attachments`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/documents/notes`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}`],
      ["PUT", `http://localhost:3100/api/issues/${ISSUE_ID}/documents/notes`],
    ]);

    const putBody = JSON.parse(String(fetchMock.mock.calls[3]![1]?.body)) as {
      body: string;
      changeSummary: string;
      title: string;
    };
    expect(putBody.body).toBe(`原有正文\n\n![登录页](/api/assets/${ASSET_ID}/content)\n`);
    expect(putBody.changeSummary).toBe("append 图片：登录页");
    expect(putBody.title).toBe("notes · MUL-900");
  });

  it("creates the document with the image when the key does not exist yet", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "paperclip-cli-test-"));
    const filePath = join(tmp, "shot.png");
    await writeFile(filePath, "png", "utf8");
    const fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);

    try {
      await run([
        "issue", "document:image", ISSUE_ID, "notes",
        "--company-id", COMPANY_ID,
        "--file", filePath,
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }

    const putBody = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body)) as { body: string };
    expect(putBody.body).toBe(`![shot.png](/api/assets/${ASSET_ID}/content)\n`);
  });

  it("rejects non-image files locally without uploading", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "paperclip-cli-test-"));
    const filePath = join(tmp, "notes.pdf");
    await writeFile(filePath, "pdf", "utf8");
    const fetchMock = routeFetch({ previousBody: "x" });
    vi.stubGlobal("fetch", fetchMock);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.join(" "));
    });

    try {
      await expect(run([
        "issue", "document:image", ISSUE_ID, "notes",
        "--company-id", COMPANY_ID,
        "--file", filePath,
      ])).rejects.toThrowError(/process\.exit/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errors.join("\n")).toContain("png/jpg/webp/gif");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
