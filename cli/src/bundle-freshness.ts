import fs from "node:fs";
import path from "node:path";

/**
 * 包过期告警（第三次同类事故后加）。
 *
 * `~/.local/bin/paperclip` 是指向 `cli/dist/index.js` 的符号链接，而 dist 是
 * esbuild 产物且被 gitignore：拉完代码不 build，终端就一直跑旧包，**没有任何
 * 提示**。三次都是这么坏的：
 *
 * - MUL-139：新子命令合进 master，包还在回答 unknown command
 * - openspec:link：新命令在源码里，包里没有
 * - x-paperclip-session：新请求头在源码里，包不发这个头，服务端静默跳过登记
 *
 * 最后一次尤其难查：命令成功返回，只是某个副作用没发生，看起来像业务 bug。
 *
 * 已有的两道防线都在构建侧——`verify-cli-dist` 只在 build 时跑且只查 workspace
 * 子命令名，dev-runner 只在它自己重启时 build。运行时一直是零检查，而恰恰是
 * 运行时那一刻才知道用的是哪个包。
 *
 * 判据用 git SHA 不用文件时间：checkout 会重写 mtime 但内容可能没变，切分支后
 * mtime 也可能不动，两个方向都会误判。SHA 直接回答「这个包是哪次提交打的」。
 *
 * 工作区里改了源码没提交时 SHA 不变，这里看不出来——那个场景归 dev-runner，
 * 它在重启时无条件重建。两道防线合起来才盖住：**已提交的变动**归这里，
 * **未提交的改动**归 dev-runner。
 */

/** 构建时由 esbuild 注入；跑源码（tsx）时是 undefined，那种情况下没有包可谈。 */
declare const __PAPERCLIP_BUILD_SHA__: string | undefined;

/** 读 .git 里当前 HEAD 指向的 commit，不 fork 出 git 进程。 */
function readHeadSha(repoRoot: string): string | null {
  try {
    const head = fs.readFileSync(path.join(repoRoot, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head || null;
    const ref = head.slice(4).trim();
    const refPath = path.join(repoRoot, ".git", ref);
    if (fs.existsSync(refPath)) return fs.readFileSync(refPath, "utf8").trim() || null;
    // 打包过的 ref（git gc 之后松散 ref 文件会消失，落进 packed-refs）
    const packed = fs.readFileSync(path.join(repoRoot, ".git", "packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    return line?.split(" ")[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * 从包自己的位置往上找仓库根。装在别处（npm 全局安装的正式版本）时找不到
 * `.git`，那说明它不是从源码仓链过来的，本来就不该比对。
 */
function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 包比当前代码旧就在 stderr 说一句。
 *
 * 只提示不拦：包旧不代表这条命令一定坏，拦下来会把「顺手跑一条命令」变成
 * 「先 build 再说」。走 stderr 是为了不污染 `--json` 的管道。
 */
export function warnIfBundleStale(distDir: string, warn: (message: string) => void): void {
  const buildSha = typeof __PAPERCLIP_BUILD_SHA__ === "string" ? __PAPERCLIP_BUILD_SHA__ : undefined;
  if (!buildSha || buildSha === "unknown") return;

  const repoRoot = findRepoRoot(distDir);
  if (!repoRoot) return;

  const headSha = readHeadSha(repoRoot);
  if (!headSha || headSha === buildSha) return;

  warn(
    [
      `paperclip: 这个 CLI 包是 ${buildSha.slice(0, 8)} 打的，仓库现在在 ${headSha.slice(0, 8)}。`,
      `  命令可能少了新加的子命令、参数或请求头，而且多半不报错——只是某件事没发生。`,
      `  重建：pnpm --filter paperclipai build`,
    ].join("\n"),
  );
}
