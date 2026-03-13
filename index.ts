import { realpathSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { isDmlStatement, parseSQL } from "./src/parser";
import { scanMigrations, type Migration } from "./src/scanner";
import {
  buildPrismaMigrationSyncScript,
  PRISMA_MIGRATION_SYNC_SCRIPT_NAME,
} from "./src/prisma-sync";
import { squashMigrations } from "./src/squash";
import { parseExcludePatterns } from "./src/selection";
import { assertOutputDirNotInSelectedMigrations } from "./src/output";
import {
  confirmRemoveDml,
  selectMigrations,
  type SelectionPreset,
  confirmSquash,
  getOutputName,
  printKeptDmlWarning,
  printResult,
  printPreview,
} from "./src/tui";

export interface CliOptions {
  migrationsPath: string;
  fromMigration?: string;
  latestCount?: number;
  excludePatterns: string[];
  allowGaps: boolean;
  autoConfirm: boolean;
  removeDml: boolean;
  outputName?: string;
}

export interface DmlHandlingState {
  hasDml: boolean;
  removeDml: boolean;
  shouldPrompt: boolean;
  shouldWarn: boolean;
}

function printHelp(): void {
  console.log(`
pattypan [migrationsPath] [options]

Options:
  --from <migration>      Use boundary migration (name or unique fragment)
  --exclude <patterns>    Comma-separated migration name filters to exclude
  --latest, -n <count>    Legacy: squash latest N migrations
  --allow-gaps            Legacy latest mode: allow non-contiguous selection
  --yes, -y               Skip squash confirmation prompt
  --remove-dml            Strip INSERT/UPDATE/DELETE from squashed output
  --name <migration>      Output migration directory name
  --help                  Show help
`);
}

export function parseCliOptions(argv: string[]): CliOptions {
  let migrationsPath = "prisma/migrations";
  let fromMigration: string | undefined;
  let latestCount: number | undefined;
  const excludePatterns: string[] = [];
  let allowGaps = false;
  let autoConfirm = false;
  let removeDml = false;
  let outputName: string | undefined;

  const args = [...argv];
  let i = 0;

  while (i < args.length) {
    const arg = args[i] as string;

    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--from") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--from requires a value");
      }

      fromMigration = value;
      i += 2;
      continue;
    }

    if (arg === "--latest" || arg === "-n") {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }

      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid latest count: ${value}`);
      }

      latestCount = parsed;
      i += 2;
      continue;
    }

    if (arg === "--exclude") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--exclude requires a value");
      }

      excludePatterns.push(...parseExcludePatterns(value));
      i += 2;
      continue;
    }

    if (arg === "--allow-gaps") {
      allowGaps = true;
      i += 1;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      autoConfirm = true;
      i += 1;
      continue;
    }

    if (arg === "--remove-dml") {
      removeDml = true;
      i += 1;
      continue;
    }

    if (arg === "--name") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--name requires a value");
      }

      outputName = value;
      i += 2;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    migrationsPath = arg;
    i += 1;
  }

  if (fromMigration && typeof latestCount === "number") {
    throw new Error("Use either --from or --latest, not both.");
  }

  return {
    migrationsPath,
    fromMigration,
    latestCount,
    excludePatterns,
    allowGaps,
    autoConfirm,
    removeDml,
    outputName,
  };
}

export function migrationContainsDml(migration: Migration): boolean {
  return parseSQL(migration.sql).some((statement) => isDmlStatement(statement));
}

export function selectedMigrationsContainDml(migrations: Migration[]): boolean {
  return migrations.some((migration) => migrationContainsDml(migration));
}

export function getDmlHandlingState(
  options: Pick<CliOptions, "autoConfirm" | "removeDml">,
  hasDml: boolean
): DmlHandlingState {
  const shouldPrompt = hasDml && !options.autoConfirm && !options.removeDml;

  return {
    hasDml,
    removeDml: options.removeDml,
    shouldPrompt,
    shouldWarn: hasDml && options.autoConfirm && !options.removeDml,
  };
}

export function shouldCancelSquashAfterRemovingDml(
  removeDml: boolean,
  keptStatementCount: number
): boolean {
  return removeDml && keptStatementCount === 0;
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2));

  try {
    console.log(chalk.dim(`Scanning ${options.migrationsPath}...`));
    const migrations = await scanMigrations(options.migrationsPath);

    if (migrations.length === 0) {
      console.log(chalk.yellow("No migrations found."));
      process.exit(0);
    }

    const selectionPreset: SelectionPreset | undefined = options.fromMigration
      ? {
          fromMigration: options.fromMigration,
          excludePatterns: options.excludePatterns,
        }
      : typeof options.latestCount === "number"
      ? {
          latestCount: options.latestCount,
          excludePatterns: options.excludePatterns,
          allowGaps: options.allowGaps,
        }
      : undefined;

    const selected = await selectMigrations(migrations, selectionPreset);

    if (selected.length === 0) {
      console.log(chalk.yellow("No migrations selected."));
      process.exit(0);
    }

    if (selected.length === 1) {
      console.log(chalk.yellow("Need at least 2 migrations to squash."));
      process.exit(0);
    }

    const hasDml = selectedMigrationsContainDml(selected);
    const dmlHandling = getDmlHandlingState(options, hasDml);
    let removeDml = dmlHandling.removeDml;

    if (dmlHandling.shouldPrompt) {
      removeDml = await confirmRemoveDml();
    } else if (dmlHandling.shouldWarn) {
      printKeptDmlWarning();
    }

    const result = squashMigrations(selected, { removeDml });

    if (shouldCancelSquashAfterRemovingDml(removeDml, result.keptStatements.length)) {
      console.log(chalk.yellow("Removing DML left no statements to write. Squash cancelled."));
      process.exit(0);
    }

    printPreview(result);

    if (!options.autoConfirm) {
      const confirmed = await confirmSquash(selected, result);
      if (!confirmed) {
        console.log(chalk.yellow("\nSquash cancelled."));
        process.exit(0);
      }
    }

    const outputName = options.outputName ?? (await getOutputName());

    const outputDir = join(options.migrationsPath, outputName);
    assertOutputDirNotInSelectedMigrations(selected, outputDir);
    await mkdir(outputDir, { recursive: true });

    const outputPath = join(outputDir, "migration.sql");
    await writeFile(outputPath, result.sql, "utf-8");
    const prismaMigrationSyncScriptPath = join(
      options.migrationsPath,
      PRISMA_MIGRATION_SYNC_SCRIPT_NAME
    );
    await writeFile(
      prismaMigrationSyncScriptPath,
      buildPrismaMigrationSyncScript({
        outputMigrationName: outputName,
        outputSql: result.sql,
        replacedMigrations: selected,
      }),
      "utf-8"
    );

    for (const migration of selected) {
      await rm(migration.path, { recursive: true, force: true });
    }

    printResult(outputPath, result, prismaMigrationSyncScriptPath);
  } catch (error) {
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

export function isMainModule(metaUrl: string, entryPath = process.argv[1]): boolean {
  if (!entryPath) return false;

  const modulePath = fileURLToPath(metaUrl);

  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return resolve(entryPath) === resolve(modulePath);
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
