import { readdir, readFile } from "fs/promises";
import { join } from "path";

export interface Migration {
  name: string;
  path: string;
  timestamp: string;
  sql: string;
}

export async function scanMigrations(
  migrationsPath: string = "prisma/migrations"
): Promise<Migration[]> {
  const migrations: Migration[] = [];

  try {
    const entries = await readdir(migrationsPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "migration_lock.toml") continue;

      const migrationDir = join(migrationsPath, entry.name);
      const sqlPath = join(migrationDir, "migration.sql");

      try {
        const sql = await readFile(sqlPath, "utf-8");
        const timestamp = entry.name.split("_")[0] ?? entry.name;

        migrations.push({
          name: entry.name,
          path: migrationDir,
          timestamp,
          sql,
        });
      } catch {
        // Skip directories without migration.sql
      }
    }

    // Sort by timestamp
    migrations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return migrations;
  } catch (error) {
    throw new Error(
      `Failed to scan migrations at ${migrationsPath}: ${error}`
    );
  }
}
