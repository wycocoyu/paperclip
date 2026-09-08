// Removes the client sidecar (.paperclip-skill.json) from skill inventories that
// were written before the directory scan learned to skip it. Re-runnable: rows
// already clean are left untouched. Run this BEFORE restarting a server that
// carries the scan fix, so bundled-release snapshots still match their registry.
//
// Usage (from the repo root): pnpm skills:strip-sidecar [-- --company <id>] [-- --dry-run]
// It lives in the server workspace because drizzle-orm only resolves there.
import { eq } from "drizzle-orm";
import { SKILL_SIDECAR_FILENAME } from "@paperclipai/shared";
import { companySkills, companySkillVersions, createDb } from "../../packages/db/src/index.js";
import { loadConfig } from "../src/config.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function stripSidecar<T extends Record<string, unknown>>(inventory: T[] | null | undefined): T[] | null {
  if (!Array.isArray(inventory)) return null;
  const kept = inventory.filter((entry) => entry?.path !== SKILL_SIDECAR_FILENAME);
  return kept.length === inventory.length ? null : kept;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const companyId = parseFlag("--company");
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const versionRows = await db
    .select({
      id: companySkillVersions.id,
      companyId: companySkillVersions.companyId,
      companySkillId: companySkillVersions.companySkillId,
      revisionNumber: companySkillVersions.revisionNumber,
      fileInventory: companySkillVersions.fileInventory,
    })
    .from(companySkillVersions)
    .then((rows) => (companyId ? rows.filter((row) => row.companyId === companyId) : rows));

  let versionsFixed = 0;
  for (const row of versionRows) {
    const next = stripSidecar(row.fileInventory as unknown as Array<Record<string, unknown>>);
    if (!next) continue;
    versionsFixed += 1;
    console.log(`version ${row.companySkillId} rev${row.revisionNumber} (${row.id})`);
    if (dryRun) continue;
    await db
      .update(companySkillVersions)
      .set({ fileInventory: next as never })
      .where(eq(companySkillVersions.id, row.id));
  }

  const skillRows = await db
    .select({
      id: companySkills.id,
      companyId: companySkills.companyId,
      key: companySkills.key,
      fileInventory: companySkills.fileInventory,
    })
    .from(companySkills)
    .then((rows) => (companyId ? rows.filter((row) => row.companyId === companyId) : rows));

  let skillsFixed = 0;
  for (const row of skillRows) {
    const next = stripSidecar(row.fileInventory);
    if (!next) continue;
    skillsFixed += 1;
    console.log(`skill ${row.key} (${row.id})`);
    if (dryRun) continue;
    await db
      .update(companySkills)
      .set({ fileInventory: next, updatedAt: new Date() })
      .where(eq(companySkills.id, row.id));
  }

  console.log(
    `${dryRun ? "[dry-run] would strip" : "stripped"} ${SKILL_SIDECAR_FILENAME} from ${versionsFixed} version snapshot(s) and ${skillsFixed} skill inventor(ies).`,
  );
  // The pool keeps the event loop alive, so a one-shot script has to close it.
  await db.$client.end();
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Skill sidecar strip failed: ${message}`);
  process.exitCode = 1;
});
