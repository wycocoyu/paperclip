/**
 * esbuild configuration for building the paperclipai CLI for npm.
 *
 * Bundles all workspace packages (@paperclipai/*) into a single file.
 * External npm packages remain as regular dependencies.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledCliNpmDependencies } from "../scripts/cli-bundled-npm-dependencies.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Workspace packages whose code should be bundled into the CLI.
// Note: "server" is excluded — it's published separately and resolved at runtime.
const workspacePaths = [
  "cli",
  "packages/db",
  "packages/shared",
  "packages/skill-materializer",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/hermes-gateway",
  "packages/adapters/hermes",
  "packages/adapters/openclaw-gateway",
];

// Workspace packages that should NOT be bundled — they'll be published
// to npm and resolved at runtime (e.g. @paperclipai/server uses dynamic import).
const externalWorkspacePackages = new Set([
  "@paperclipai/server",
]);

// Collect all external (non-workspace) npm package names
const externals = new Set();
for (const p of workspacePaths) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, p, "package.json"), "utf8"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (externalWorkspacePackages.has(name)) {
      externals.add(name);
    } else if (!name.startsWith("@paperclipai/") && !bundledCliNpmDependencies.has(name)) {
      externals.add(name);
    }
  }
  for (const name of Object.keys(pkg.optionalDependencies || {})) {
    externals.add(name);
  }
}
// Also add all published workspace packages as external
for (const name of externalWorkspacePackages) {
  externals.add(name);
}

if (bundledCliNpmDependencies.has("embedded-postgres")) {
  const requireFromDb = createRequire(resolve(repoRoot, "packages/db/package.json"));
  const embeddedPostgresRoot = dirname(requireFromDb.resolve("embedded-postgres"));
  const embeddedPostgresPackage = JSON.parse(
    readFileSync(resolve(embeddedPostgresRoot, "..", "package.json"), "utf8"),
  );
  for (const name of Object.keys(embeddedPostgresPackage.optionalDependencies ?? {})) {
    externals.add(name);
  }
}

/** 构建时的 HEAD。读 .git 而不是 fork 一个 git 进程，构建脚本不该依赖 PATH 里有 git。 */
function buildSha() {
  try {
    const head = readFileSync(resolve(repoRoot, ".git/HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head || "unknown";
    const ref = head.slice(4).trim();
    try {
      return readFileSync(resolve(repoRoot, ".git", ref), "utf8").trim() || "unknown";
    } catch {
      const packed = readFileSync(resolve(repoRoot, ".git/packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
      return line?.split(" ")[0]?.trim() ?? "unknown";
    }
  } catch {
    return "unknown";
  }
}

/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/index.js",
  banner: { js: "#!/usr/bin/env node" },
  // 包里刻上它是哪次提交打的，运行时拿来跟当前 HEAD 比（bundle-freshness.ts）。
  // 拿不到就写 unknown，检查随之关闭——从 tar 包解出来构建时没有 .git 是正常的。
  define: { __PAPERCLIP_BUILD_SHA__: JSON.stringify(buildSha()) },
  external: [...externals].sort(),
  treeShaking: true,
  sourcemap: true,
};
