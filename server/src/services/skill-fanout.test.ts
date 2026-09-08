import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { companySkills, companySkillVersions } from "@paperclipai/db";
import {
  acquireSkillsPullLock,
  materializeSkill,
  readSidecar,
  skillsPullLockPath,
  type SkillSnapshotFile,
} from "@paperclipai/skill-materializer";
import {
  configureSkillFanout,
  publishSkillVersionPublished,
  reconcileSkillFanoutOnStartup,
  resetSkillFanoutForTests,
  skillFanoutFailures,
} from "./skill-fanout.js";
import { companySkillService } from "./company-skills.js";

/**
 * MUL-559 第 3 步红绿测试。materializer 与锁全部真跑（临时目录），db 用
 * thenable queryResult 模式（参照 issue-prerequisites.test.ts）。
 *
 * 覆盖：
 *  ① createVersion 事务回滚 → 零 publish（成功路径对照：提交后才扇出）
 *  ② 同 skill 连发三次合并，落盘为最新版本
 *  ③ SkillsPullLockBusyError：不消耗 attempts，锁释放后补投递
 *  ④ startup reconcile 三分支（markers 匹配零动作 / 不匹配重物化 / 无 sidecar 视为漂移）
 *  ⑤ drift 冲突进 failures 且目录未被覆盖（P0-1）
 */

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

interface TestSkill {
  id: string;
  companyId: string;
  key: string;
  slug: string;
  currentVersionId: string | null;
  updatedAt: Date;
}

type FanoutDbState = {
  skills: TestSkill[];
  /** Resolved at query time so a burst of publishes reads the newest version. */
  filesForCurrentVersion: (skill: TestSkill) => SkillSnapshotFile[];
};

// `await db.select({...}).from(table).where(cond)` — the condition is opaque to
// the mock, so each test keeps exactly one skill in state and the rows are
// unambiguous.
function thenable(rows: unknown[]): unknown {
  return {
    then: (
      onFulfilled: (value: unknown[]) => unknown,
      onRejected: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
}

function makeFanoutDb(state: FanoutDbState): Pick<Db, "select"> {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          thenable(
            table === companySkillVersions
              ? state.skills[0]?.currentVersionId
                ? [{ fileInventory: state.filesForCurrentVersion(state.skills[0]) }]
                : []
              : [...state.skills],
          ),
      }),
    }),
  } as unknown as Pick<Db, "select">;
}

const files = (body: string): SkillSnapshotFile[] => [
  { path: "SKILL.md", content: body },
  { path: "reference.md", content: `# reference\n\n${body}\n` },
];

async function waitForTrue(fn: () => boolean | Promise<boolean>, label: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Only the retry scheduler is faked; fs (and everything else) stays real, so a
// delivery's fs chain finishes on real event-loop turns fired by setImmediate.
async function flushRealTasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Like flushRealTasks, but keeps yielding until an observable settles — the fs
// threadpool's completion latency varies, so fixed round counts flake.
async function flushRealTasksUntil(
  cond: () => boolean | Promise<boolean>,
  label: string,
  budgetMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("skill fan-out coordinator", () => {
  let paperclipHome: string;
  let oldPaperclipHome: string | undefined;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    // Isolates skillsPullLockPath() so the lock tests never touch the real
    // ~/.paperclip (a live CLI pull shares it).
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "skill-fanout-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
  });

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  beforeEach(() => {
    resetSkillFanoutForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSkillFanoutForTests();
  });

  async function newProjection(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-team-"));
    tempDirs.push(dir);
    configureSkillFanout({ dir, companyId: COMPANY_ID });
    return dir;
  }

  const skill = (overrides: Partial<TestSkill> = {}): TestSkill => ({
    id: "22222222-2222-4222-8222-222222222222",
    companyId: COMPANY_ID,
    key: "test-skill",
    slug: "test-skill",
    currentVersionId: "v-1",
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  });

  it("① createVersion 事务回滚 → 零 publish；提交成功后才扇出", async () => {
    const projectionDir = await newProjection();
    const target = path.join(projectionDir, "rollback-skill");

    const makeTxDb = (fail: boolean) => {
      const fanoutState: FanoutDbState = {
        skills: [skill({ slug: "rollback-skill", currentVersionId: "v-new" })],
        filesForCurrentVersion: () => files("# rollback skill v-new"),
      };
      const base = makeFanoutDb(fanoutState);
      const versionRow = {
        id: "v-new",
        companyId: COMPANY_ID,
        companySkillId: fanoutState.skills[0].id,
        revisionNumber: 2,
        label: null,
        releaseId: null,
        releaseName: null,
        releasedAt: null,
        fileInventory: files("# rollback skill v-new"),
        authorAgentId: null,
        authorUserId: null,
        createdAt: new Date(),
      };
      const tx = {
        execute: async () => {},
        select: () => ({ from: () => ({ where: () => thenable([{ nextRevision: 2 }]) }) }),
        insert: () => ({
          values: () => ({
            returning: () =>
              fail ? Promise.reject(new Error("simulated commit failure")) : thenable([versionRow]),
          }),
        }),
        update: () => ({ set: () => ({ where: () => thenable([]) }) }),
      };
      return {
        ...base,
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
      } as unknown as Db;
    };

    const createOptions = () =>
      ({
        skipInventoryRefresh: true,
        skill: { fileInventory: [] },
        fileInventory: files("# rollback skill v-new"),
      }) as unknown as Parameters<ReturnType<typeof companySkillService>["createVersion"]>[4];

    // 回滚：事务抛错穿过后置 drain，零扇出。
    configureSkillFanout({ dir: projectionDir, companyId: COMPANY_ID });
    await expect(
      companySkillService(makeTxDb(true)).createVersion(
        COMPANY_ID,
        skill({ slug: "rollback-skill" }).id,
        {},
        null,
        createOptions(),
      ),
    ).rejects.toThrow("simulated commit failure");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(skillFanoutFailures(COMPANY_ID)).toEqual([]);

    // 对照：提交成功 → publish 落盘。
    await companySkillService(makeTxDb(false)).createVersion(
      COMPANY_ID,
      skill({ slug: "rollback-skill" }).id,
      {},
      null,
      createOptions(),
    );
    await waitForTrue(async () => {
      const sidecar = await readSidecar(target);
      return sidecar?.currentVersionId === "v-new";
    }, "committed version fan-out lands");
    expect(skillFanoutFailures(COMPANY_ID)).toEqual([]);
  });

  it("② 同 skill 连发三次合并，落盘为最新版本", async () => {
    const projectionDir = await newProjection();
    const state: FanoutDbState = {
      skills: [skill()],
      filesForCurrentVersion: (s) => files(`# test skill ${s.currentVersionId}`),
    };
    const db = makeFanoutDb(state);

    publishSkillVersionPublished(db as Db, { companyId: COMPANY_ID, skillId: state.skills[0].id, versionId: "v-1" });
    state.skills[0].currentVersionId = "v-2";
    publishSkillVersionPublished(db as Db, { companyId: COMPANY_ID, skillId: state.skills[0].id, versionId: "v-2" });
    state.skills[0].currentVersionId = "v-3";
    publishSkillVersionPublished(db as Db, { companyId: COMPANY_ID, skillId: state.skills[0].id, versionId: "v-3" });

    const target = path.join(projectionDir, state.skills[0].slug);
    await waitForTrue(async () => (await readSidecar(target))?.currentVersionId === "v-3", "newest version materializes");
    const body = await fs.readFile(path.join(target, "SKILL.md"), "utf8");
    expect(body).toBe("# test skill v-3");
    expect(skillFanoutFailures(COMPANY_ID)).toEqual([]);
  });

  it("③ 锁忙不消耗 attempts，锁释放后补投递", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const projectionDir = await newProjection();
    const state: FanoutDbState = {
      skills: [skill()],
      filesForCurrentVersion: () => files("# test skill v-1"),
    };
    const db = makeFanoutDb(state);

    const lock = await acquireSkillsPullLock(skillsPullLockPath());
    expect(lock).not.toBeNull();

    try {
      publishSkillVersionPublished(db as Db, { companyId: COMPANY_ID, skillId: state.skills[0].id, versionId: "v-1" });
      await flushRealTasks();

      // 十二轮、每轮快进 70s（未修复时退避 1→32s 全程都在第一轮里烧完）：
      // 若锁忙计入 MAX_ATTEMPTS，第六次就会放弃并进 failures。
      for (let round = 0; round < 12; round += 1) {
        await vi.advanceTimersByTimeAsync(70_000);
        await flushRealTasks();
      }
      expect(skillFanoutFailures(COMPANY_ID)).toEqual([]);
    } finally {
      await lock!.release();
    }

    await vi.advanceTimersByTimeAsync(1_000);
    const target = path.join(projectionDir, state.skills[0].slug);
    await flushRealTasksUntil(async () => (await readSidecar(target)) !== null, "delivery after lock release");
    const sidecar = await readSidecar(target);
    expect(sidecar?.currentVersionId).toBe("v-1");
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("# test skill v-1");
    expect(skillFanoutFailures(COMPANY_ID)).toEqual([]);
  });

  describe.each([
    ["markers 匹配 → 零动作", true, { queued: 0, upToDate: 1 }, "v-1"],
    ["markers 不匹配 → 重物化", false, { queued: 1, upToDate: 0 }, "v-1"],
    ["无 sidecar（目录不存在）→ 视为漂移", null, { queued: 1, upToDate: 0 }, "v-1"],
  ] as const)("④ startup reconcile：%s", (label, seedState, expected, expectedVersion) => {
    it(`返回 ${JSON.stringify(expected)} 且磁盘收敛到 ${expectedVersion}`, async () => {
      const projectionDir = await newProjection();
      const current = skill({ slug: "reconcile-skill", currentVersionId: "v-1" });
      const state: FanoutDbState = {
        skills: [current],
        filesForCurrentVersion: () => files(`# reconcile skill ${current.currentVersionId}`),
      };

      if (seedState === true || seedState === false) {
        await materializeSkill({
          skillId: current.id,
          targetDir: path.join(projectionDir, current.slug),
          files: files(`# reconcile skill ${seedState ? "v-1" : "v-0"}`),
          sidecar: {
            key: current.key,
            currentVersionId: seedState ? "v-1" : "v-0",
            updatedAt: current.updatedAt,
          },
        });
      }

      const result = await reconcileSkillFanoutOnStartup(makeFanoutDb(state) as Db);
      expect(result).toEqual({ scanned: 1, queued: expected.queued, upToDate: expected.upToDate });

      const target = path.join(projectionDir, current.slug);
      await waitForTrue(
        async () => (await readSidecar(target))?.currentVersionId === expectedVersion,
        `disk converges to ${expectedVersion} (${label})`,
      );
      if (seedState === true) {
        // 匹配分支零动作：不重物化、不重写 sidecar。
        const body = await fs.readFile(path.join(target, "SKILL.md"), "utf8");
        expect(body).toBe("# reconcile skill v-1");
      } else if (seedState === false) {
        const body = await fs.readFile(path.join(target, "SKILL.md"), "utf8");
        expect(body).toBe("# reconcile skill v-1");
      }
      expect(skillFanoutFailures(COMPANY_ID)).toEqual([]);
    });
  });

  it("⑤ drift 冲突进 failures 且目录未被覆盖", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const projectionDir = await newProjection();
    const current = skill();
    const state: FanoutDbState = {
      skills: [current],
      filesForCurrentVersion: () => files(`# test skill ${current.currentVersionId}`),
    };
    const db = makeFanoutDb(state);
    const target = path.join(projectionDir, current.slug);

    // 基线投递成功，随后目录被本地改动污染。
    publishSkillVersionPublished(db as Db, { companyId: COMPANY_ID, skillId: current.id, versionId: "v-1" });
    await flushRealTasksUntil(async () => (await readSidecar(target)) !== null, "baseline delivery lands");
    expect(await readSidecar(target)).not.toBeNull();
    const localEdit = "# test skill v-1 (locally edited)";
    await fs.writeFile(path.join(target, "SKILL.md"), localEdit, "utf8");

    // 服务端来了新版本：目标目录有本地改动，不得覆盖。六轮快进（每轮
    // 70s > 退避全程 63s）后断言终态：修复后进 failures；未修复时静默
    // 跳过、无 failure——两种终态都由下面的断言裁决。
    current.currentVersionId = "v-2";
    publishSkillVersionPublished(db as Db, { companyId: COMPANY_ID, skillId: current.id, versionId: "v-2" });
    await flushRealTasks();
    for (let round = 0; round < 6; round += 1) {
      await vi.advanceTimersByTimeAsync(70_000);
      await flushRealTasks(100);
    }

    const [failure] = skillFanoutFailures(COMPANY_ID);
    expect(failure).toBeDefined();
    expect(failure.skillId).toBe(current.id);
    expect(failure.attempts).toBe(6);
    expect(failure.lastError).toContain("use --force");
    expect(failure.lastAttemptAt).toBeTruthy();
    expect(skillFanoutFailures("99999999-9999-4999-8999-999999999999")).toEqual([]);

    // 本地改动原样保留，未被 v-2 覆盖。
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(localEdit);
  });
});
