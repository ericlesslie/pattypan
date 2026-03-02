import { resolve } from "path";
import type { Migration } from "./scanner";

export function assertOutputDirNotInSelectedMigrations(
  selectedMigrations: Migration[],
  outputDir: string
): void {
  const normalizedOutputDir = resolve(outputDir);

  const conflictingMigration = selectedMigrations.find(
    (migration) => resolve(migration.path) === normalizedOutputDir
  );

  if (conflictingMigration) {
    throw new Error(
      `Output migration directory conflicts with selected migration "${conflictingMigration.name}". Choose a different output name.`
    );
  }
}
