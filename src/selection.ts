import type { Migration } from "./scanner";

export interface LatestSelectionResult {
  selected: Migration[];
  excluded: Migration[];
  unmatchedExcludePatterns: string[];
  gapMigrations: Migration[];
  hasGaps: boolean;
}

export interface BoundarySelectionResult {
  boundary: Migration;
  selected: Migration[];
}

export interface MigrationChoice {
  name: string;
  value: string;
  checked: boolean;
}

function normalizePattern(pattern: string): string {
  return pattern.trim();
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesExcludePattern(migrationName: string, pattern: string): boolean {
  const normalized = normalizePattern(pattern);
  if (!normalized) return false;

  if (normalized.includes("*")) {
    return wildcardToRegExp(normalized).test(migrationName);
  }

  return migrationName.toLowerCase().includes(normalized.toLowerCase());
}

function filterMigrationsByExcludePatterns(
  migrations: Migration[],
  excludePatterns: string[]
): Pick<LatestSelectionResult, "selected" | "excluded" | "unmatchedExcludePatterns"> {
  const matchedPatternCounts = new Map<string, number>();
  const excluded: Migration[] = [];
  const selected: Migration[] = [];

  for (const migration of migrations) {
    const matchedPattern = excludePatterns.find((pattern) =>
      matchesExcludePattern(migration.name, pattern)
    );

    if (matchedPattern) {
      excluded.push(migration);
      matchedPatternCounts.set(
        matchedPattern,
        (matchedPatternCounts.get(matchedPattern) ?? 0) + 1
      );
      continue;
    }

    selected.push(migration);
  }

  const unmatchedExcludePatterns = excludePatterns.filter(
    (pattern) => !matchedPatternCounts.has(pattern)
  );

  return {
    selected,
    excluded,
    unmatchedExcludePatterns,
  };
}

export function parseExcludePatterns(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => normalizePattern(value))
    .filter((value) => value.length > 0);
}

export function getMigrationsNewestFirst(migrations: Migration[]): Migration[] {
  return [...migrations].reverse();
}

export function resolveMigrationByQuery(
  migrations: Migration[],
  query: string
): Migration {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error("--from requires a non-empty migration value");
  }

  const lowered = normalized.toLowerCase();

  const exactMatches = migrations.filter(
    (migration) => migration.name.toLowerCase() === lowered
  );

  if (exactMatches.length === 1) {
    return exactMatches[0] as Migration;
  }

  if (exactMatches.length > 1) {
    const lines = exactMatches.map((migration) => `  - ${migration.name}`).join("\n");
    throw new Error(
      `Multiple migrations matched --from "${query}" (exact match):\n${lines}`
    );
  }

  const partialMatches = migrations.filter((migration) =>
    migration.name.toLowerCase().includes(lowered)
  );

  if (partialMatches.length === 1) {
    return partialMatches[0] as Migration;
  }

  if (partialMatches.length === 0) {
    throw new Error(
      `No migration matched --from "${query}". Use an exact name or unique fragment.`
    );
  }

  const lines = partialMatches.map((migration) => `  - ${migration.name}`).join("\n");
  throw new Error(
    `Multiple migrations matched --from "${query}". Be more specific:\n${lines}`
  );
}

export function selectMigrationsFromBoundary(
  migrations: Migration[],
  boundaryMigrationName: string
): BoundarySelectionResult {
  const boundaryIndex = migrations.findIndex(
    (migration) => migration.name === boundaryMigrationName
  );

  if (boundaryIndex === -1) {
    throw new Error(
      `Boundary migration "${boundaryMigrationName}" was not found in migration list`
    );
  }

  return {
    boundary: migrations[boundaryIndex] as Migration,
    selected: migrations.slice(boundaryIndex),
  };
}

export function buildPrecheckedMigrationChoices(
  migrations: Migration[]
): MigrationChoice[] {
  return migrations.map((migration) => ({
    name: migration.name,
    value: migration.name,
    checked: true,
  }));
}

export function selectMigrationsByNames(
  migrations: Migration[],
  selectedNames: string[]
): Migration[] {
  const selectedNameSet = new Set(selectedNames);
  return migrations.filter((migration) => selectedNameSet.has(migration.name));
}

export function applyExcludePatterns(
  migrations: Migration[],
  excludePatterns: string[]
): Pick<LatestSelectionResult, "selected" | "excluded" | "unmatchedExcludePatterns"> {
  return filterMigrationsByExcludePatterns(migrations, excludePatterns);
}

export function selectLatestMigrations(
  migrations: Migration[],
  latestCount: number,
  excludePatterns: string[]
): LatestSelectionResult {
  if (!Number.isInteger(latestCount) || latestCount < 1) {
    throw new Error(`Latest count must be a positive integer. Received: ${latestCount}`);
  }

  const filtered = filterMigrationsByExcludePatterns(migrations, excludePatterns);
  const selected = filtered.selected.slice(-latestCount);

  const selectedNameSet = new Set(selected.map((migration) => migration.name));
  const selectedIndexes = migrations
    .map((migration, index) => ({ migration, index }))
    .filter(({ migration }) => selectedNameSet.has(migration.name))
    .map(({ index }) => index);

  const gapMigrations: Migration[] = [];
  if (selectedIndexes.length > 1) {
    const minIndex = selectedIndexes[0] ?? 0;
    const maxIndex = selectedIndexes[selectedIndexes.length - 1] ?? 0;

    for (let i = minIndex; i <= maxIndex; i++) {
      const migration = migrations[i];
      if (migration && !selectedNameSet.has(migration.name)) {
        gapMigrations.push(migration);
      }
    }
  }

  return {
    selected,
    excluded: filtered.excluded,
    unmatchedExcludePatterns: filtered.unmatchedExcludePatterns,
    gapMigrations,
    hasGaps: gapMigrations.length > 0,
  };
}
