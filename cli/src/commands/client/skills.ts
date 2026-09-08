import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  agentSkillAssignmentModeSchema,
  type AgentSkillAssignmentMode,
  type Agent,
  type AgentSkillSnapshot,
  type CatalogSkill,
  type CompanySkill,
  type CompanySkillAuditResult,
  type CompanySkillDetail,
  type CompanySkillFileDetail,
  type CompanySkillImportResult,
  type CompanySkillInstallCatalogResult,
  type CompanySkillListItem,
  type CompanySkillProjectScanResult,
  type CompanySkillUpdateStatus,
} from "@paperclipai/shared";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";
import {
  containsPullManagedLinks,
  terminalSkillTargets,
} from "./skill-links.js";
import {
  expandHome,
  listCompanySkills,
  materializeCompanySkills,
  resolveCompanySkillReference,
  toSkillReferenceTarget,
  type CompanySkillReferenceTarget,
  type SkillMaterializeOptions,
  type SkillMaterializeRow,
} from "./skill-materialize.js";
import {
  SKILLS_PULL_HINT,
  printSkillsPullResult,
  resolveSkillsPullRoot,
  runSkillsPull,
  type SkillsPullOptions,
} from "./skills-pull.js";
import { collectSkillsStatus, printSkillsStatus } from "./skills-status.js";
import { collectSkillsUsage, printSkillsUsage } from "./skills-usage.js";

export {
  materializeCompanySkills,
  resolveCompanySkillReference,
  type CompanySkillReferenceTarget,
  type SkillMaterializeRow,
} from "./skill-materialize.js";

interface SkillsOptions extends BaseClientOptions {
  companyId?: string;
}

interface SkillsListOptions extends SkillsOptions {
  query?: string;
}

interface SkillFileOptions extends SkillsOptions {
  path?: string;
}

interface SkillCreateOptions extends SkillsOptions {
  name: string;
  slug?: string;
  description?: string;
  bodyFile?: string;
}

interface SkillMaterializeCommandOptions extends SkillsOptions, SkillMaterializeOptions {}

interface SkillsPullCommandOptions extends SkillsOptions, SkillsPullOptions {}

interface SkillScanProjectsOptions extends SkillsOptions {
  projectId?: string[];
  workspaceId?: string[];
}

interface CatalogBrowseOptions extends BaseClientOptions {
  kind?: string;
  category?: string;
  query?: string;
}

interface CatalogInstallOptions extends SkillsOptions {
  as?: string;
  force?: boolean;
}

interface SkillUpdateOptions extends SkillsOptions {
  all?: boolean;
  force?: boolean;
}

interface ConfirmedSkillOptions extends SkillsOptions {
  yes?: boolean;
  force?: boolean;
}

interface AgentSkillSyncOptions extends SkillsOptions {
  skill?: string[];
  mode: AgentSkillAssignmentMode;
}

export interface CompanySkillCheckRow {
  skill: CompanySkillReferenceTarget;
  status: CompanySkillUpdateStatus;
}

export interface CompanySkillUpdateRow {
  skillRef: string;
  action: "updated" | "skipped" | "failed";
  skill?: CompanySkill;
  status?: CompanySkillUpdateStatus;
  reason?: string;
}

export function registerSkillsCommands(program: Command): void {
  const skills = program.command("skills").description("Company and agent skill operations");

  addCommonClientOptions(
    skills
      .command("browse")
      .description("Browse app-shipped catalog skills without installing them")
      .option("--kind <kind>", "Catalog kind filter (bundled or optional)")
      .option("--category <slug>", "Catalog category filter")
      .option("--query <text>", "Search catalog text")
      .action(async (opts: CatalogBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogSkills(ctx, opts);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogSkillRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    skills
      .command("search")
      .description("Search app-shipped catalog skills without installing them")
      .argument("<query>", "Search text")
      .option("--kind <kind>", "Catalog kind filter (bundled or optional)")
      .option("--category <slug>", "Catalog category filter")
      .action(async (query: string, opts: CatalogBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogSkills(ctx, { ...opts, query });
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogSkillRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    skills
      .command("inspect")
      .description("Inspect an app-shipped catalog skill before installing it")
      .argument("<catalogRef>", "Catalog skill ID, key, or unique slug")
      .action(async (catalogRef: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const detail = await getCatalogSkill(ctx, catalogRef);
          if (ctx.json) {
            printOutput(detail, { json: true });
            return;
          }
          printCatalogSkillDetail(detail);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    skills
      .command("install")
      .description("Install a catalog skill into the company skill library; does not attach it to agents")
      .argument("<catalogRef>", "Catalog skill ID, key, or unique slug")
      .option("--as <slug>", "Company skill slug override")
      .option("--force", "Replace a same-key catalog-managed skill when the server allows it", false)
      .action(async (catalogRef: string, opts: CatalogInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CompanySkillInstallCatalogResult>(
            `/api/companies/${ctx.companyId}/skills/install-catalog`,
            {
              catalogSkillId: catalogRef,
              slug: opts.as,
              force: opts.force || undefined,
            },
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printCatalogInstallResult(result);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("list")
      .description("List company skills; --query filters by name, slug, key, or description")
      .option("-q, --query <text>", "Only show skills matching this text")
      .action(async (opts: SkillsListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const all = await listCompanySkills(ctx);
          const rows = filterCompanySkills(all, opts.query);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (opts.query && rows.length === 0) {
            console.log(`No company skill matches "${opts.query}" (${all.length} skill(s) in the library).`);
            return;
          }
          printCompanySkillRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("show")
      .description("Show company skill details")
      .argument("<skillRef>", "Company skill ID, key, or unique slug")
      .action(async (skillRef: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          const detail = await ctx.api.get<CompanySkillDetail>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}`,
          );
          printOutput(detail, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("file")
      .description("Print a company skill file")
      .argument("<skillRef>", "Company skill ID, key, or unique slug")
      .option("--path <path>", "Relative file path", "SKILL.md")
      .action(async (skillRef: string, opts: SkillFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          const params = new URLSearchParams({ path: opts.path?.trim() || "SKILL.md" });
          const file = await ctx.api.get<CompanySkillFileDetail>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/files?${params.toString()}`,
          );
          if (ctx.json) {
            printOutput(file, { json: true });
            return;
          }
          process.stdout.write(file?.content ?? "");
          if (file?.content && !file.content.endsWith("\n")) {
            process.stdout.write("\n");
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("import")
      .description("Import company skills from a local path, GitHub, skills.sh, or URL source")
      .argument("<source>", "Skill source")
      .action(async (source: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CompanySkillImportResult>(
            `/api/companies/${ctx.companyId}/skills/import`,
            { source },
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          console.log(
            `Imported ${result?.imported.length ?? 0} skill(s); warnings=${result?.warnings.length ?? 0}`,
          );
          printCompanySkillRows(result?.imported ?? []);
          for (const warning of result?.warnings ?? []) {
            console.log(`warning=${warning}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("create")
      .description("Create a managed local company skill")
      .requiredOption("--name <name>", "Skill name")
      .option("--slug <slug>", "Skill slug")
      .option("--description <text>", "Skill description")
      .option("--body-file <path>", "Markdown body file; use - to read stdin")
      .action(async (opts: SkillCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const markdown = opts.bodyFile ? await readBodyFile(opts.bodyFile) : undefined;
          const created = await ctx.api.post<CompanySkill>(
            `/api/companies/${ctx.companyId}/skills`,
            {
              name: opts.name,
              slug: opts.slug,
              description: opts.description,
              markdown,
            },
          );
          if (ctx.json) {
            printOutput(created, { json: true });
            return;
          }
          console.log(`Created skill ${created?.name ?? opts.name} (${created?.key ?? created?.id ?? "unknown"})`);
          console.log(SKILLS_PULL_HINT);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("scan-projects")
      .description("Scan project workspaces for skills")
      .option("--project-id <id>", "Project ID to scan; may be repeated", collectOptionValue, [] as string[])
      .option("--workspace-id <id>", "Workspace ID to scan; may be repeated", collectOptionValue, [] as string[])
      .action(async (opts: SkillScanProjectsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CompanySkillProjectScanResult>(
            `/api/companies/${ctx.companyId}/skills/scan-projects`,
            {
              projectIds: emptyToUndefined(opts.projectId),
              workspaceIds: emptyToUndefined(opts.workspaceId),
            },
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          console.log(
            `Scanned projects=${result?.scannedProjects ?? 0} workspaces=${result?.scannedWorkspaces ?? 0} discovered=${result?.discovered ?? 0} imported=${result?.imported.length ?? 0} updated=${result?.updated.length ?? 0} skipped=${result?.skipped.length ?? 0} conflicts=${result?.conflicts.length ?? 0} warnings=${result?.warnings.length ?? 0}`,
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("pull")
      .description(
        "Materialize company skills into the repo checkout and link them into the local terminal skill directories",
      )
      .option("--dir <path>", "Limit to a terminal skill directory; may be repeated", collectOptionValue, [] as string[])
      .option("--adopt", "Replace byte-identical local skill directories with managed symlinks", false)
      .option("--prune-apply", "Delete what the prune report lists instead of only reporting it", false)
      .option("--dry-run", "Report the plan without writing anything", false)
      .option("--force", "Overwrite locally-modified or foreign skill directories in the repo checkout", false)
      .action(async (opts: SkillsPullCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await runSkillsPull(ctx, opts);
          if (!result) {
            if (!ctx.json) console.log("Another skills pull holds the lock; skipping this run.");
            return;
          }
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printSkillsPullResult(result, opts);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("materialize")
      .description(
        "Materialize company skills into local terminal skill directories (e.g. ~/.codex/skills) with fingerprint protection",
      )
      .option("-t, --target <path>", "Target skill directory; may be repeated", collectOptionValue, [] as string[])
      .option("-s, --skill <ref>", "Limit to specific company skills; may be repeated", collectOptionValue, [] as string[])
      .option("--dry-run", "Report planned writes without writing anything", false)
      .option("--force", "Overwrite locally-modified or foreign skill directories", false)
      .action(async (opts: SkillMaterializeCommandOptions) => {
        try {
          if (opts.target.length === 0) {
            throw new Error("At least one --target directory is required (e.g. --target ~/.codex/skills).");
          }
          for (const target of opts.target) {
            await assertMaterializeTargetAllowed(target);
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await materializeCompanySkills(ctx, opts);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printSkillMaterializeRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("check")
      .description("Check company skill update status")
      .argument("[skillRef]", "Company skill ID, key, or unique slug")
      .action(async (skillRef: string | undefined, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await checkCompanySkills(ctx, skillRef);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCompanySkillCheckRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("update")
      .description("Install company skill updates")
      .argument("[skillRef]", "Company skill ID, key, or unique slug")
      .option("--all", "Check all skills and install available updates", false)
      .option("--force", "Discard local-modification or soft-audit holds; hard-stop audit findings still fail", false)
      .action(async (skillRef: string | undefined, opts: SkillUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (opts.all && skillRef?.trim()) {
            throw new Error("Use either a skill reference or --all, not both.");
          }
          const rows = opts.all
            ? await updateAllCompanySkills(ctx, opts)
            : [await updateOneCompanySkill(ctx, requireSkillRef(skillRef), opts)];
          if (ctx.json) {
            printOutput(rows.length === 1 && !opts.all ? rows[0] : rows, { json: true });
            return;
          }
          printCompanySkillUpdateRows(rows);
          if (rows.some((row) => row.action === "updated")) {
            console.log(SKILLS_PULL_HINT);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("audit")
      .description("Audit installed company skill bytes without executing them")
      .argument("[skillRef]", "Company skill ID, key, or unique slug")
      .action(async (skillRef: string | undefined, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await auditCompanySkills(ctx, skillRef);
          if (ctx.json) {
            printOutput(rows.length === 1 && skillRef ? rows[0]?.audit : rows, { json: true });
            return;
          }
          printCompanySkillAuditRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("reset")
      .description("Reset a catalog-managed company skill to its pinned installed origin")
      .argument("<skillRef>", "Company skill ID, key, or unique slug")
      .option("--yes", "Confirm reset without prompting", false)
      .option("--force", "Discard local modifications or accept soft audit warnings; hard-stop audit findings still fail", false)
      .action(async (skillRef: string, opts: ConfirmedSkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          await confirmDangerousAction(opts.yes, `Reset catalog skill "${skill.name}" (${skill.key}) to its pinned origin?`);
          const reset = await ctx.api.post<CompanySkill>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/reset`,
            { force: opts.force || undefined },
          );
          if (ctx.json) {
            printOutput(reset, { json: true });
            return;
          }
          console.log(`Reset skill ${reset?.name ?? skill.name} (${reset?.key ?? skill.key}) to pinned origin.`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("remove")
      .description("Remove a company skill")
      .argument("<skillRef>", "Company skill ID, key, or unique slug")
      .option("--yes", "Confirm removal without prompting", false)
      .action(async (skillRef: string, opts: ConfirmedSkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          await confirmDangerousAction(opts.yes, `Remove company skill "${skill.name}" (${skill.key})?`);
          const removed = await ctx.api.delete<CompanySkill>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}`,
          );
          if (ctx.json) {
            printOutput(removed, { json: true });
            return;
          }
          console.log(`Removed skill ${removed?.name ?? skill.name} (${removed?.key ?? skill.key})`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  // Editing a skill means editing its managed-root directory, then telling the
  // library to look again. Without this command that second step was a
  // hand-rolled curl, which is how skills ended up registered with only their
  // SKILL.md while their references sat on disk unnoticed.
  addCommonClientOptions(
    skills
      .command("rescan")
      .description("Re-read a managed skill's directory and publish a new version (run after editing files under the managed root)")
      .argument("<skillRef>", "Company skill ID, key, or unique slug")
      .action(async (skillRef: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          const result = await ctx.api.post<{
            skill: CompanySkill;
            version?: { revisionNumber?: number; fileInventory?: unknown[] };
            added: string[];
            removed: string[];
          }>(`/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/rescan`, {});
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          const fileCount = result?.version?.fileInventory?.length ?? 0;
          console.log(`Rescanned ${result?.skill?.name ?? skill.name}: revision ${result?.version?.revisionNumber ?? "?"}, ${fileCount} file(s)`);
          if (result?.added?.length) console.log(`  added: ${result.added.join(", ")}`);
          if (result?.removed?.length) console.log(`  removed: ${result.removed.join(", ")}`);
          console.log("Run `paperclip skills pull` to distribute it to the terminals.");
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  // The managed root is where a skill is actually edited, and its path is not
  // guessable — it sits under the Paperclip instance directory, keyed by
  // company. Printing it beats documenting it.
  addCommonClientOptions(
    skills
      .command("where")
      .description("Print the managed-root directory a skill is edited in")
      .argument("[skillRef]", "Company skill ID, key, or unique slug; omit for the company's skills root")
      .action(async (skillRef: string | undefined, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (!skillRef) {
            console.log(join(homedir(), ".paperclip", "instances", "default", "skills", ctx.companyId!));
            return;
          }
          const skill = await resolveCompanySkill(ctx, skillRef);
          const detail = await ctx.api.get<CompanySkill & { sourceLocator?: string | null }>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}`,
          );
          const locator = detail?.sourceLocator?.trim();
          if (!locator) {
            console.error(`${skill.name} has no local directory (source type ${detail?.sourceType ?? "unknown"}); it is not edited locally.`);
            process.exitCode = 1;
            return;
          }
          console.log(locator);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  // One line per skill answering the three questions that otherwise take an
  // `ls -la` across five directories: where is it projected, was it edited
  // locally, is the server failing to deliver it.
  addCommonClientOptions(
    skills
      .command("status")
      .description("Show per-terminal projection, local drift, and fan-out failures for every skill")
      .action(async (opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await collectSkillsStatus(ctx, await resolveSkillsPullRoot());
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printSkillsStatus(result);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  // Local-only: it reads this machine's transcripts and talks to no server, so
  // it stays out of resolveCommandContext and works with the server down.
  skills
    .command("usage")
    .description("Count skill usage per skill, grouped by harness — explicit Skill tool calls for claude/zcode, sessions that read SKILL.md for codex (this machine only)")
    .option("--days <n>", "Only scan session files written within the last N days", "30")
    .option("--no-cache", "Ignore and rewrite the incremental scan cache")
    .option("--json", "Output raw JSON")
    .action(async (opts: { days: string; cache: boolean; json?: boolean }) => {
      try {
        const days = Number.parseInt(opts.days, 10);
        if (!Number.isFinite(days) || days <= 0) {
          throw new Error(`--days must be a positive integer, got "${opts.days}".`);
        }
        const result = await collectSkillsUsage({ days, cache: opts.cache });
        if (opts.json) {
          printOutput(result, { json: true });
          return;
        }
        printSkillsUsage(result);
      } catch (err) {
        handleCommandError(err);
      }
    });

  registerAgentSkillCommands(skills);
}

function registerAgentSkillCommands(skills: Command): void {
  const agent = skills.command("agent").description("Agent desired-skill and runtime sync operations");

  addCommonClientOptions(
    agent
      .command("list")
      .description("List an agent runtime skill snapshot")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .action(async (agentRef: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx, agentRef);
          const snapshot = await ctx.api.get<AgentSkillSnapshot>(
            `/api/agents/${encodeURIComponent(agentRow.id)}/skills`,
          );
          if (ctx.json) {
            printOutput(snapshot, { json: true });
            return;
          }
          printAgentSkillSnapshot(snapshot, agentRow);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    agent
      .command("sync")
      .description("Merge an agent's desired company skills and sync runtime state")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .option("--skill <skillRef>", "Desired company skill ID, key, or slug; may be repeated", collectOptionValue, [] as string[])
      .requiredOption(
        "--mode <mode>",
        "Merge mode: add keeps other skills; remove deletes only named skills; replace destructively overwrites the complete set",
      )
      .action(async (agentRef: string, opts: AgentSkillSyncOptions) => {
        try {
          const desiredSkills = opts.skill ?? [];
          if (desiredSkills.length === 0) {
            throw new Error("At least one --skill value is required for skills agent sync.");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx, agentRef);
          const mode = agentSkillAssignmentModeSchema.parse(opts.mode);
          const snapshot = await ctx.api.post<AgentSkillSnapshot>(
            `/api/agents/${encodeURIComponent(agentRow.id)}/skills/sync`,
            { desiredSkills, mode },
          );
          if (ctx.json) {
            printOutput(snapshot, { json: true });
            return;
          }
          console.log(
            `Desired company skills updated with ${mode} mode for ${agentRow.name} (${agentRow.id}); runtime sync returned ${snapshot?.entries.length ?? 0} entrie(s).`,
          );
          printAgentSkillSnapshot(snapshot, agentRow);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    agent
      .command("clear")
      .description("Clear an agent's desired company skills and sync runtime state")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .option("--yes", "Confirm clear without prompting", false)
      .action(async (agentRef: string, opts: ConfirmedSkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx, agentRef);
          await confirmDangerousAction(
            opts.yes,
            `Clear desired company skills for "${agentRow.name}" (${agentRow.id})?`,
          );
          const snapshot = await ctx.api.post<AgentSkillSnapshot>(
            `/api/agents/${encodeURIComponent(agentRow.id)}/skills/sync`,
            { desiredSkills: [], mode: "replace" },
          );
          if (ctx.json) {
            printOutput(snapshot, { json: true });
            return;
          }
          console.log(
            `Desired company skills cleared for ${agentRow.name} (${agentRow.id}).`,
          );
          printAgentSkillSnapshot(snapshot, agentRow);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

// Terminal skill directories belong to `skills pull` now: writing real skill
// directories into them behind pull's back leaves entries it can neither track
// nor safely prune.
async function assertMaterializeTargetAllowed(rawTarget: string): Promise<void> {
  const target = expandHome(rawTarget);
  const terminal = terminalSkillTargets().find((entry) => resolvePath(entry.dir) === resolvePath(target));
  if (terminal) {
    throw new Error(
      `Refusing to materialize into ${target}: the ${terminal.tool} skill directory is managed by \`paperclipai skills pull\`. Run that instead.`,
    );
  }
  if (await containsPullManagedLinks(target)) {
    throw new Error(
      `Refusing to materialize into ${target}: it already holds symlinks managed by \`paperclipai skills pull\`. Run that instead.`,
    );
  }
}

function printSkillMaterializeRows(rows: SkillMaterializeRow[]): void {
  for (const row of rows) {
    console.log(`${row.status.padEnd(24)} ${row.skill.key} -> ${row.target} (${row.files} files)${row.note ? ` — ${row.note}` : ""}`);
  }
}

async function listCatalogSkills(
  ctx: ResolvedClientContext,
  opts: CatalogBrowseOptions,
): Promise<CatalogSkill[]> {
  const params = new URLSearchParams();
  appendQueryParam(params, "kind", opts.kind);
  appendQueryParam(params, "category", opts.category);
  appendQueryParam(params, "q", opts.query);
  const query = params.toString();
  return (await ctx.api.get<CatalogSkill[]>(`/api/skills/catalog${query ? `?${query}` : ""}`)) ?? [];
}

async function getCatalogSkill(ctx: ResolvedClientContext, catalogRef: string): Promise<CatalogSkill> {
  const ref = catalogRef.trim();
  if (!ref) {
    throw new Error("Catalog skill reference is required.");
  }
  const detail = await ctx.api.get<CatalogSkill>(`/api/skills/catalog/ref?ref=${encodeURIComponent(ref)}`);
  if (!detail) {
    throw new Error(`Catalog skill not found: ${catalogRef}`);
  }
  return detail;
}

async function resolveCompanySkill(
  ctx: ResolvedClientContext,
  reference: string,
): Promise<CompanySkillReferenceTarget> {
  return resolveCompanySkillReference(await listCompanySkills(ctx), reference);
}

async function checkCompanySkills(
  ctx: ResolvedClientContext,
  skillRef: string | undefined,
): Promise<CompanySkillCheckRow[]> {
  const skills = await listCompanySkills(ctx);
  const selected = skillRef ? [resolveCompanySkillReference(skills, skillRef)] : skills;
  const rows: CompanySkillCheckRow[] = [];
  for (const skill of selected) {
    const status = await ctx.api.get<CompanySkillUpdateStatus>(
      `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/update-status`,
    );
    if (!status) {
      throw new Error(`No update status returned for skill ${skill.key}.`);
    }
    rows.push({ skill: toSkillReferenceTarget(skill), status });
  }
  return rows;
}

async function updateOneCompanySkill(
  ctx: ResolvedClientContext,
  skillRef: string,
  opts: SkillUpdateOptions = {},
): Promise<CompanySkillUpdateRow> {
  const skill = await resolveCompanySkill(ctx, skillRef);
  const updated = await ctx.api.post<CompanySkill>(
    `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/install-update`,
    { force: opts.force || undefined },
  );
  return {
    skillRef,
    action: "updated",
    skill: updated ?? undefined,
  };
}

async function updateAllCompanySkills(ctx: ResolvedClientContext, opts: SkillUpdateOptions = {}): Promise<CompanySkillUpdateRow[]> {
  const checks = await checkCompanySkills(ctx, undefined);
  const rows: CompanySkillUpdateRow[] = [];
  for (const row of checks) {
    if (!row.status.supported) {
      rows.push({
        skillRef: row.skill.key,
        action: "skipped",
        status: row.status,
        reason: row.status.reason ?? "Update checks are not supported for this skill.",
      });
      continue;
    }
    if (!row.status.hasUpdate) {
      rows.push({
        skillRef: row.skill.key,
        action: "skipped",
        status: row.status,
        reason: "Already current.",
      });
      continue;
    }
    try {
      const updated = await ctx.api.post<CompanySkill>(
        `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(row.skill.id)}/install-update`,
        { force: opts.force || undefined },
      );
      rows.push({
        skillRef: row.skill.key,
        action: "updated",
        status: row.status,
        skill: updated ?? undefined,
      });
    } catch (err) {
      rows.push({
        skillRef: row.skill.key,
        action: "failed",
        status: row.status,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows;
}

async function auditCompanySkills(
  ctx: ResolvedClientContext,
  skillRef: string | undefined,
): Promise<Array<{ skill: CompanySkillReferenceTarget; audit: CompanySkillAuditResult }>> {
  const skills = await listCompanySkills(ctx);
  const selected = skillRef ? [resolveCompanySkillReference(skills, skillRef)] : skills;
  const rows: Array<{ skill: CompanySkillReferenceTarget; audit: CompanySkillAuditResult }> = [];
  for (const skill of selected) {
    const audit = await ctx.api.post<CompanySkillAuditResult>(
      `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/audit`,
      {},
    );
    if (!audit) {
      throw new Error(`No audit result returned for skill ${skill.key}.`);
    }
    rows.push({ skill: toSkillReferenceTarget(skill), audit });
  }
  return rows;
}

async function resolveAgent(ctx: ResolvedClientContext, agentRef: string): Promise<Agent> {
  const params = new URLSearchParams({ companyId: ctx.companyId ?? "" });
  const agent = await ctx.api.get<Agent>(`/api/agents/${encodeURIComponent(agentRef)}?${params.toString()}`);
  if (!agent) {
    throw new Error(`Agent not found: ${agentRef}`);
  }
  return agent;
}

/**
 * Substring match over the fields a person actually remembers a skill by.
 * `skills search` looks at the shipped catalog, not the company library, so
 * finding one of your own team's skills had no command at all — only reading
 * the whole list.
 */
function filterCompanySkills<T extends { name?: string; slug?: string; key?: string; description?: string | null }>(
  rows: T[],
  query: string | undefined,
): T[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    [row.name, row.slug, row.key, row.description]
      .some((field) => typeof field === "string" && field.toLowerCase().includes(needle)),
  );
}

function printCompanySkillRows(rows: Array<CompanySkillListItem | CompanySkill>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.id,
        key: row.key,
        slug: row.slug,
        name: row.name,
        source: "sourceBadge" in row ? row.sourceBadge : row.sourceType,
        trust: row.trustLevel,
        compatibility: row.compatibility,
        attachedAgents: "attachedAgentCount" in row ? row.attachedAgentCount : undefined,
      }),
    );
  }
}

function printCatalogSkillRows(rows: CatalogSkill[]): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  printTable(rows.map((row) => ({
    id: row.id,
    key: row.key,
    kind: row.kind,
    category: row.category,
    slug: row.slug,
    name: row.name,
    trust: row.trustLevel,
    roles: row.recommendedForRoles.join(",") || "-",
  })));
}

function printCatalogSkillDetail(skill: CatalogSkill): void {
  console.log(
    formatInlineRecord({
      id: skill.id,
      key: skill.key,
      kind: skill.kind,
      category: skill.category,
      slug: skill.slug,
      name: skill.name,
      trust: skill.trustLevel,
      compatibility: skill.compatibility,
      contentHash: skill.contentHash,
    }),
  );
  console.log(`description=${skill.description || "-"}`);
  console.log(`recommendedForRoles=${skill.recommendedForRoles.join(",") || "-"}`);
  console.log(`tags=${skill.tags.join(",") || "-"}`);
  console.log("files:");
  printTable(skill.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  })));
}

function printCatalogInstallResult(result: CompanySkillInstallCatalogResult | null): void {
  if (!result) {
    console.log("Catalog install returned no result.");
    return;
  }
  console.log(
    `Catalog skill ${result.action}: ${result.skill.name} (${result.skill.key}) in company skill library.`,
  );
  console.log(
    "This does not attach the skill to an agent. Use `paperclipai skills agent sync <agent> --skill <skill>` when you want an agent to use it.",
  );
  for (const warning of result.warnings) {
    console.log(`warning=${warning}`);
  }
}

function printCompanySkillCheckRows(rows: CompanySkillCheckRow[]): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.skill.id,
        key: row.skill.key,
        slug: row.skill.slug,
        name: row.skill.name,
        supported: row.status.supported,
        hasUpdate: row.status.hasUpdate,
        currentRef: row.status.currentRef,
        latestRef: row.status.latestRef,
        installedHash: row.status.installedHash,
        originHash: row.status.originHash,
        hold: row.status.updateHoldReason,
        audit: row.status.auditVerdict,
        reason: row.status.reason,
      }),
    );
  }
}

function printCompanySkillAuditRows(rows: Array<{ skill: CompanySkillReferenceTarget; audit: CompanySkillAuditResult }>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.skill.id,
        key: row.skill.key,
        slug: row.skill.slug,
        verdict: row.audit.verdict,
        installedHash: row.audit.installedHash,
        originHash: row.audit.originHash,
        codes: row.audit.codes.join(",") || null,
      }),
    );
    for (const finding of row.audit.findings) {
      console.log(
        formatInlineRecord({
          severity: finding.severity,
          code: finding.code,
          path: finding.path,
          message: finding.message,
        }),
      );
    }
  }
}

function printCompanySkillUpdateRows(rows: CompanySkillUpdateRow[]): void {
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        action: row.action,
        skillRef: row.skillRef,
        key: row.skill?.key,
        slug: row.skill?.slug,
        hasUpdate: row.status?.hasUpdate,
        reason: row.reason,
      }),
    );
  }
}

function printAgentSkillSnapshot(snapshot: AgentSkillSnapshot | null, agent: Agent): void {
  if (!snapshot) {
    console.log(`Agent ${agent.name} (${agent.id}) returned no skill snapshot.`);
    return;
  }
  console.log(
    `Agent ${agent.name} (${agent.id}) adapter=${snapshot.adapterType} supported=${snapshot.supported} mode=${snapshot.mode} desiredCompanySkills=${snapshot.desiredSkills.length}`,
  );
  if (snapshot.warnings.length > 0) {
    for (const warning of snapshot.warnings) {
      console.log(`warning=${warning}`);
    }
  }
  if (snapshot.entries.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const entry of snapshot.entries) {
    console.log(
      formatInlineRecord({
        key: entry.key,
        runtimeName: entry.runtimeName,
        desired: entry.desired,
        managed: entry.managed,
        state: entry.state,
        origin: entry.origin,
        detail: entry.detail,
      }),
    );
  }
}

function requireSkillRef(skillRef: string | undefined): string {
  if (!skillRef?.trim()) {
    throw new Error("Skill reference is required unless --all is used.");
  }
  return skillRef;
}

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function emptyToUndefined(values: string[] | undefined): string[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function appendQueryParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) {
    params.set(key, trimmed);
  }
}

function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  const columns = Object.keys(rows[0] ?? {});
  const widths = new Map(columns.map((column) => [column, column.length]));
  for (const row of rows) {
    for (const column of columns) {
      widths.set(column, Math.max(widths.get(column) ?? 0, renderTableValue(row[column]).length));
    }
  }
  console.log(columns.map((column) => column.padEnd(widths.get(column) ?? column.length)).join("  "));
  console.log(columns.map((column) => "-".repeat(widths.get(column) ?? column.length)).join("  "));
  for (const row of rows) {
    console.log(
      columns
        .map((column) => renderTableValue(row[column]).padEnd(widths.get(column) ?? column.length))
        .join("  "),
    );
  }
}

function renderTableValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

async function readBodyFile(filePath: string): Promise<string> {
  if (filePath === "-") {
    return readStdin();
  }
  return readFile(filePath, "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function confirmDangerousAction(yes: boolean | undefined, message: string): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("This command requires --yes when not running in an interactive terminal.");
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${message} Type yes to continue: `)).trim().toLowerCase();
    if (answer !== "yes") {
      throw new Error("Aborted.");
    }
  } finally {
    rl.close();
  }
}
