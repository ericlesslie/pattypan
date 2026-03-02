#!/usr/bin/env bun
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import chalk from "chalk";
import { scanMigrations } from "./src/scanner";
import { squashMigrations } from "./src/squash";
import { parseExcludePatterns } from "./src/selection";
import { assertOutputDirNotInSelectedMigrations } from "./src/output";
import {
  selectMigrations,
  type SelectionPreset,
  confirmSquash,
  getOutputName,
  printResult,
  printPreview,
} from "./src/tui";

interface CliOptions {
  migrationsPath: string;
  fromMigration?: string;
  latestCount?: number;
  excludePatterns: string[];
  allowGaps: boolean;
  autoConfirm: boolean;
  outputName?: string;
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
  --name <migration>      Output migration directory name
  --help                  Show help
`);
}

function parseCliOptions(argv: string[]): CliOptions {
  let migrationsPath = "prisma/migrations";
  let fromMigration: string | undefined;
  let latestCount: number | undefined;
  const excludePatterns: string[] = [];
  let allowGaps = false;
  let autoConfirm = false;
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
    outputName,
  };
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

    const result = squashMigrations(selected);
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

    for (const migration of selected) {
      await rm(migration.path, { recursive: true, force: true });
    }

    printResult(outputPath, result);
  } catch (error) {
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

main();
