import { checkbox, confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import type { Migration } from "./scanner";
import type { SquashResult } from "./squash";
import {
  applyExcludePatterns,
  buildPrecheckedMigrationChoices,
  getMigrationsNewestFirst,
  resolveMigrationByQuery,
  selectLatestMigrations,
  selectMigrationsByNames,
  selectMigrationsFromBoundary,
} from "./selection";

export interface SelectionPreset {
  latestCount?: number;
  excludePatterns?: string[];
  allowGaps?: boolean;
  fromMigration?: string;
  preselectedNames?: string[];
}

function printLatestSelectionSummary(
  latestCount: number,
  excludePatterns: string[],
  selected: Migration[],
  excluded: Migration[]
): void {
  console.log(chalk.bold("\n--- Legacy Quick Selection ---\n"));
  console.log(chalk.dim(`Latest count: ${latestCount}`));
  console.log(
    chalk.dim(
      `Exclusions: ${excludePatterns.length > 0 ? excludePatterns.join(", ") : "none"}`
    )
  );
  console.log(chalk.green(`Selected migrations: ${selected.length}`));

  if (excluded.length > 0) {
    console.log(chalk.yellow(`Excluded migrations: ${excluded.length}`));
  }

  selected.forEach((migration) => {
    console.log(chalk.cyan(`  - ${migration.name}`));
  });

  console.log("");
}

function printBoundarySelectionSummary(params: {
  boundary: Migration;
  autoSelectedCount: number;
  precheckedCount: number;
  finalSelectedCount: number;
  excludePatterns: string[];
  excludedCount: number;
}): void {
  console.log(chalk.bold("\n--- Quick Selection ---\n"));
  console.log(chalk.dim(`Boundary migration: ${params.boundary.name}`));
  console.log(chalk.dim(`Auto-selected (boundary + newer): ${params.autoSelectedCount}`));

  if (params.excludePatterns.length > 0) {
    console.log(chalk.dim(`Exclusions: ${params.excludePatterns.join(", ")}`));
  }

  if (params.excludedCount > 0) {
    console.log(chalk.yellow(`Excluded by pattern: ${params.excludedCount}`));
  }

  console.log(chalk.dim(`Prechecked for cherry-pick: ${params.precheckedCount}`));
  console.log(chalk.green(`Final selected count: ${params.finalSelectedCount}`));
  console.log("");
}

function printUnmatchedExcludePatterns(unmatchedPatterns: string[]): void {
  if (unmatchedPatterns.length === 0) return;
  console.log(
    chalk.yellow(`No migration matched exclusions: ${unmatchedPatterns.join(", ")}`)
  );
}

async function promptBoundaryMigration(migrations: Migration[]): Promise<Migration> {
  const newestFirst = getMigrationsNewestFirst(migrations);

  const selectedName = await select({
    message: "Select the earliest migration to include:",
    choices: newestFirst.map((migration) => ({
      name: chalk.cyan(migration.name),
      value: migration.name,
    })),
    pageSize: 5,
  });

  const selected = migrations.find((migration) => migration.name === selectedName);
  if (!selected) {
    throw new Error("Selected boundary migration was not found");
  }

  return selected;
}

async function selectLegacyLatestModeMigrations(
  migrations: Migration[],
  options: SelectionPreset
): Promise<Migration[]> {
  const latestCount = options.latestCount;
  if (typeof latestCount !== "number") {
    throw new Error("Legacy latest mode requires latestCount");
  }

  const excludePatterns = options.excludePatterns ?? [];
  const selection = selectLatestMigrations(migrations, latestCount, excludePatterns);

  printLatestSelectionSummary(
    latestCount,
    excludePatterns,
    selection.selected,
    selection.excluded
  );

  printUnmatchedExcludePatterns(selection.unmatchedExcludePatterns);

  if (selection.hasGaps && !options.allowGaps) {
    console.log(chalk.red("Selection is non-contiguous due to exclusions:"));
    selection.gapMigrations.forEach((migration) => {
      console.log(chalk.red(`  - ${migration.name}`));
    });

    const proceedWithGaps = await confirm({
      message:
        "This can reorder migration effects. Continue with a non-contiguous squash?",
      default: false,
    });

    if (!proceedWithGaps) {
      console.log(chalk.yellow("Quick selection cancelled."));
      return [];
    }
  }

  return selection.selected;
}

async function selectBoundaryModeMigrations(
  migrations: Migration[],
  options?: SelectionPreset
): Promise<Migration[]> {
  const excludePatterns = options?.excludePatterns ?? [];

  const boundary = options?.fromMigration
    ? resolveMigrationByQuery(migrations, options.fromMigration)
    : await promptBoundaryMigration(migrations);

  const boundarySelection = selectMigrationsFromBoundary(migrations, boundary.name);
  const autoSelected = boundarySelection.selected;
  const filtered = applyExcludePatterns(autoSelected, excludePatterns);

  printUnmatchedExcludePatterns(filtered.unmatchedExcludePatterns);

  let finalSelected = filtered.selected;

  if (Array.isArray(options?.preselectedNames)) {
    finalSelected = selectMigrationsByNames(filtered.selected, options.preselectedNames);
  } else if (!options?.fromMigration) {
    const selectedNames = await checkbox({
      message: "Review selected migrations (space to toggle, enter to confirm):",
      choices: buildPrecheckedMigrationChoices(filtered.selected).map((choice) => ({
        ...choice,
        name: chalk.cyan(choice.name),
      })),
      pageSize: 15,
    });

    finalSelected = selectMigrationsByNames(filtered.selected, selectedNames);
  }

  printBoundarySelectionSummary({
    boundary,
    autoSelectedCount: autoSelected.length,
    precheckedCount: filtered.selected.length,
    finalSelectedCount: finalSelected.length,
    excludePatterns,
    excludedCount: filtered.excluded.length,
  });

  return finalSelected;
}

async function selectManually(migrations: Migration[]): Promise<Migration[]> {
  const choices = migrations.map((migration, index) => ({
    name: `${chalk.cyan(migration.name)}`,
    value: index,
    checked: true,
  }));

  const selectedIndices = await checkbox({
    message: "Select migrations to squash (space to toggle, enter to confirm):",
    choices,
    pageSize: 15,
  });

  return selectedIndices
    .map((index) => migrations[index])
    .filter((migration): migration is Migration => Boolean(migration));
}

export async function selectMigrations(
  migrations: Migration[],
  preset?: SelectionPreset
): Promise<Migration[]> {
  if (migrations.length === 0) {
    console.log(chalk.yellow("No migrations found."));
    return [];
  }

  console.log(chalk.bold("\nPattypan\n"));
  console.log(chalk.dim(`Found ${migrations.length} migrations.\n`));

  if (preset?.fromMigration) {
    return selectBoundaryModeMigrations(migrations, preset);
  }

  if (typeof preset?.latestCount === "number") {
    return selectLegacyLatestModeMigrations(migrations, preset);
  }

  const mode = await select({
    message: "How do you want to pick migrations?",
    choices: [
      {
        name: "Quick mode: pick boundary migration (recommended)",
        value: "boundary",
      },
      {
        name: "Manual mode: pick migrations from list",
        value: "manual",
      },
    ],
    default: "boundary",
  });

  if (mode === "boundary") {
    return selectBoundaryModeMigrations(migrations);
  }

  return selectManually(migrations);
}

export async function confirmSquash(
  selected: Migration[],
  result: SquashResult
): Promise<boolean> {
  console.log(chalk.bold("\n--- Squash Summary ---\n"));

  console.log(chalk.green(`Migrations to squash: ${selected.length}`));
  selected.forEach((migration) => console.log(chalk.dim(`  - ${migration.name}`)));

  console.log(
    chalk.yellow(`\nStatements to keep: ${result.keptStatements.length}`)
  );
  console.log(
    chalk.red(`Statements to remove: ${result.removedStatements.length}`)
  );

  if (result.removedStatements.length > 0) {
    console.log(chalk.bold("\nRemoved statements:"));
    for (const removed of result.removedStatements) {
      console.log(chalk.dim(`  From ${removed.migration}:`));
      console.log(chalk.red(`    ${removed.statement.substring(0, 60)}...`));
      console.log(chalk.yellow(`    Reason: ${removed.reason}`));
    }
  }

  console.log("");

  return await confirm({
    message: "Proceed with squash?",
    default: true,
  });
}

export async function getOutputName(): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .substring(0, 14);

  return await input({
    message: "Enter name for squashed migration:",
    default: `${timestamp}_squashed`,
  });
}

export function printResult(outputPath: string, result: SquashResult): void {
  console.log(chalk.bold.green("\n✓ Migration squashed successfully!\n"));
  console.log(chalk.dim(`Output: ${outputPath}`));
  console.log(chalk.dim(`Statements: ${result.keptStatements.length}`));
  console.log(
    chalk.dim(`Removed redundant statements: ${result.removedStatements.length}`)
  );
}

export function printPreview(result: SquashResult): void {
  console.log(chalk.bold("\n--- SQL Preview ---\n"));
  console.log(chalk.dim(result.sql.substring(0, 2000)));
  if (result.sql.length > 2000) {
    console.log(chalk.dim("\n... (truncated)"));
  }
  console.log("");
}
