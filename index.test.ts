import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import type { Migration } from "./src/scanner";
import {
  getDmlHandlingState,
  parseCliOptions,
  selectedMigrationsContainDml,
  shouldCancelSquashAfterRemovingDml,
} from "./index";
import { PRISMA_MIGRATION_SYNC_SCRIPT_NAME } from "./src/prisma-sync";

function migration(name: string, sql: string): Migration {
  return {
    name,
    path: `/tmp/${name}`,
    timestamp: name.split("_")[0] ?? name,
    sql,
  };
}

async function createMigrationDir(root: string, name: string, sql: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "migration.sql"), sql, "utf-8");
}

function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, "run", "index.ts", ...args],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("index helpers", () => {
  test("parses --remove-dml from the CLI", () => {
    const options = parseCliOptions(["db/migrations", "--from", "add_user", "--remove-dml"]);

    expect(options.migrationsPath).toBe("db/migrations");
    expect(options.fromMigration).toBe("add_user");
    expect(options.removeDml).toBe(true);
  });

  test("detects DML across selected migrations", () => {
    const migrations = [
      migration(
        "20240101000000_init",
        'CREATE TABLE "User" ("id" TEXT NOT NULL, PRIMARY KEY ("id"));'
      ),
      migration(
        "20240102000000_backfill",
        'UPDATE "User" SET "id" = \'user_1\' WHERE "id" = \'1\';'
      ),
    ];

    expect(selectedMigrationsContainDml(migrations)).toBe(true);
  });

  test("only prompts for DML removal when DML is present in interactive mode", () => {
    expect(
      getDmlHandlingState({ autoConfirm: false, removeDml: false }, true)
    ).toMatchObject({
      hasDml: true,
      shouldPrompt: true,
      shouldWarn: false,
    });

    expect(
      getDmlHandlingState({ autoConfirm: false, removeDml: false }, false)
    ).toMatchObject({
      hasDml: false,
      shouldPrompt: false,
      shouldWarn: false,
    });

    expect(
      getDmlHandlingState({ autoConfirm: true, removeDml: false }, true)
    ).toMatchObject({
      hasDml: true,
      shouldPrompt: false,
      shouldWarn: true,
    });
  });

  test("cancels safely when DML removal leaves no statements", () => {
    expect(shouldCancelSquashAfterRemovingDml(true, 0)).toBe(true);
    expect(shouldCancelSquashAfterRemovingDml(true, 2)).toBe(false);
    expect(shouldCancelSquashAfterRemovingDml(false, 0)).toBe(false);
  });
});

describe("CLI DML flow", () => {
  test("warns in non-interactive mode and keeps DML when --remove-dml is absent", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pattypan-"));
    const migrationsDir = join(tempRoot, "migrations");
    const outputName = "20240109999999_squashed";

    try {
      await createMigrationDir(
        migrationsDir,
        "20240101000000_init",
        `
CREATE TABLE \`User\` (
  \`id\` INT NOT NULL,
  \`email\` VARCHAR(191) NOT NULL,
  PRIMARY KEY (\`id\`)
);
`
      );
      await createMigrationDir(
        migrationsDir,
        "20240102000000_backfill",
        "UPDATE `User` SET `email` = 'user@example.com';\n"
      );

      const result = runCli([
        migrationsDir,
        "--from",
        "20240101000000_init",
        "--yes",
        "--name",
        outputName,
      ]);

      const stdout = result.stdout.toString();
      const outputSql = await readFile(
        join(migrationsDir, outputName, "migration.sql"),
        "utf-8"
      );

      expect(result.exitCode).toBe(0);
      expect(stdout).toContain("Selected migrations contain INSERT/UPDATE/DELETE statements.");
      expect(outputSql).toContain("UPDATE `User` SET `email` = 'user@example.com';");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("aborts before writing or deleting migrations when DML removal leaves nothing to keep", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pattypan-"));
    const migrationsDir = join(tempRoot, "migrations");
    const outputName = "20240109999999_squashed";
    const firstMigration = "20240101000000_seed_a";
    const secondMigration = "20240102000000_seed_b";

    try {
      await createMigrationDir(
        migrationsDir,
        firstMigration,
        "INSERT INTO `User` (`id`) VALUES (1);\n"
      );
      await createMigrationDir(
        migrationsDir,
        secondMigration,
        "DELETE FROM `User` WHERE `id` = 1;\n"
      );

      const result = runCli([
        migrationsDir,
        "--from",
        firstMigration,
        "--yes",
        "--name",
        outputName,
        "--remove-dml",
      ]);

      const stdout = result.stdout.toString();

      expect(result.exitCode).toBe(0);
      expect(stdout).toContain("Removing DML left no statements to write. Squash cancelled.");
      expect(await Bun.file(join(migrationsDir, outputName, "migration.sql")).exists()).toBe(
        false
      );
      expect(await Bun.file(join(migrationsDir, firstMigration, "migration.sql")).exists()).toBe(
        true
      );
      expect(await Bun.file(join(migrationsDir, secondMigration, "migration.sql")).exists()).toBe(
        true
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("writes a Prisma migration sync helper and removes selected migration directories", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pattypan-"));
    const migrationsDir = join(tempRoot, "migrations");
    const outputName = "20240109999999_squashed";
    const firstMigration = "20240101000000_init";
    const secondMigration = "20240102000000_add_role";

    try {
      await createMigrationDir(
        migrationsDir,
        firstMigration,
        `
CREATE TABLE \`User\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);
`
      );
      await createMigrationDir(
        migrationsDir,
        secondMigration,
        `
ALTER TABLE \`User\` ADD COLUMN \`role\` VARCHAR(191) NULL;
`
      );

      const result = runCli([
        migrationsDir,
        "--from",
        firstMigration,
        "--yes",
        "--name",
        outputName,
      ]);

      const syncScriptPath = join(
        migrationsDir,
        PRISMA_MIGRATION_SYNC_SCRIPT_NAME
      );
      const syncScript = await readFile(syncScriptPath, "utf-8");

      expect(result.exitCode).toBe(0);
      expect(syncScript).toContain('main()');
      expect(syncScript).toContain("console.log('Finished');");
      expect(syncScript).toContain(outputName);
      expect(syncScript).toContain(firstMigration);
      expect(syncScript).toContain(secondMigration);
      expect(
        await Bun.file(
          join(migrationsDir, outputName, PRISMA_MIGRATION_SYNC_SCRIPT_NAME)
        ).exists()
      ).toBe(false);
      expect(await Bun.file(join(migrationsDir, firstMigration)).exists()).toBe(false);
      expect(await Bun.file(join(migrationsDir, secondMigration)).exists()).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
