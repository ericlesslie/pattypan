import { describe, expect, test } from "bun:test";
import type { Migration } from "./scanner";
import { squashMigrations } from "./squash";

function buildMigration(index: number, sql: string): Migration {
  const timestamp = `${20240101000000 + index}`;

  return {
    name: `${timestamp}_migration_${index}`,
    path: `/tmp/migration_${index}`,
    timestamp,
    sql,
  };
}

function squashSql(sqlStatements: string[]): ReturnType<typeof squashMigrations> {
  const migrations = sqlStatements.map((sql, index) => buildMigration(index + 1, sql));
  return squashMigrations(migrations);
}

describe("squashMigrations", () => {
  test("folds ALTER TABLE column changes into CREATE TABLE", () => {
    const result = squashSql([
      `
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
`,
      `
ALTER TABLE "User" ADD COLUMN "tempField" TEXT;
ALTER TABLE "User" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
`,
      `
ALTER TABLE "User" DROP COLUMN "tempField";
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE \"User\"");
    expect(result.sql).toContain(
      "\"createdAt\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP"
    );
    expect(result.sql).not.toContain("ALTER TABLE \"User\" ADD COLUMN \"createdAt\"");
    expect(result.sql).not.toContain("tempField");
    expect(result.sql).toContain("CREATE UNIQUE INDEX \"User_email_key\"");
  });

  test("handles schema-qualified ALTER TABLE statements", () => {
    const result = squashSql([
      `
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
`,
      `
ALTER TABLE "public"."User" ADD COLUMN "name" TEXT;
`,
    ]);

    expect(result.sql).toContain("\"name\" TEXT");
    expect(result.sql).not.toContain("ALTER TABLE \"public\".\"User\"");
  });

  test("removes CREATE INDEX and DROP INDEX lifecycle pairs", () => {
    const result = squashSql([
      `
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
`,
      `
CREATE INDEX "User_email_idx" ON "User"("email");
`,
      `
DROP INDEX "User_email_idx";
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE \"User\"");
    expect(result.sql).not.toContain("User_email_idx");
    expect(result.removedStatements.some((entry) => entry.reason.includes("Index"))).toBe(
      true
    );
  });

  test("removes relation add and drop lifecycle pairs (Postgres syntax)", () => {
    const result = squashSql([
      `
CREATE TABLE "Parent" (
  "id" TEXT NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "Child" (
  "id" TEXT NOT NULL,
  "parentId" TEXT,
  PRIMARY KEY ("id")
);
`,
      `
ALTER TABLE "Child"
  ADD CONSTRAINT "Child_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Parent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
`,
      `
ALTER TABLE "Child" DROP CONSTRAINT "Child_parentId_fkey";
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE \"Child\"");
    expect(result.sql).not.toContain("Child_parentId_fkey");
    expect(result.sql).not.toContain("REFERENCES \"Parent\"");
  });

  test("removes relation add and drop lifecycle pairs (MySQL DROP FOREIGN KEY syntax)", () => {
    const result = squashSql([
      `
CREATE TABLE \`Parent\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`Child\` (
  \`id\` INT NOT NULL,
  \`parentId\` INT,
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`Child\`
  ADD CONSTRAINT \`fk_child_parent\`
  FOREIGN KEY (\`parentId\`) REFERENCES \`Parent\`(\`id\`);
`,
      `
ALTER TABLE \`Child\` DROP FOREIGN KEY \`fk_child_parent\`;
`,
    ]);

    expect(result.sql).not.toContain("fk_child_parent");
    expect(result.sql).not.toContain("REFERENCES `Parent`");
  });

  test("removes transient tables created then dropped", () => {
    const result = squashSql([
      `
CREATE TABLE "Temp" (
  "id" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
`,
      `
DROP TABLE "Temp";
`,
      `
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE \"User\"");
    expect(result.sql).not.toContain("CREATE TABLE \"Temp\"");
    expect(result.sql).not.toContain("DROP TABLE \"Temp\"");
  });

  test("removes folded foreign keys that reference transient dropped tables", () => {
    const result = squashSql([
      `
CREATE TABLE "Temp" (
  "id" TEXT NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "Item" (
  "id" TEXT NOT NULL,
  "tempId" TEXT,
  PRIMARY KEY ("id")
);
`,
      `
ALTER TABLE "Item"
  ADD CONSTRAINT "Item_tempId_fkey"
  FOREIGN KEY ("tempId") REFERENCES "Temp"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
`,
      `
DROP TABLE "Temp";
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE \"Item\"");
    expect(result.sql).not.toContain("CREATE TABLE \"Temp\"");
    expect(result.sql).not.toContain("Item_tempId_fkey");
    expect(result.sql).not.toContain("REFERENCES \"Temp\"");
  });

  test("cancels add/drop column on tables created outside selected range", () => {
    const result = squashSql([
      `
ALTER TABLE "User" ADD COLUMN "tempField" TEXT;
`,
      `
ALTER TABLE "User" DROP COLUMN "tempField";
`,
    ]);

    expect(result.sql).toBe("");
    expect(result.removedStatements).toHaveLength(2);
  });

  test("keeps table but strips FK to transient table from CREATE TABLE body", () => {
    const result = squashSql([
      `
CREATE TABLE "Temp" (
  "id" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
`,
      `
CREATE TABLE "Keep" (
  "id" TEXT NOT NULL,
  "tempId" TEXT,
  CONSTRAINT "Keep_tempId_fkey" FOREIGN KEY ("tempId") REFERENCES "Temp"("id"),
  PRIMARY KEY ("id")
);
`,
      `
DROP TABLE "Temp";
`,
    ]);

    expect(result.sql).toContain('CREATE TABLE "Keep"');
    expect(result.sql).not.toContain('CREATE TABLE "Temp"');
    expect(result.sql).not.toContain("Keep_tempId_fkey");
    expect(result.sql).not.toContain('REFERENCES "Temp"');
  });

  test("folds MySQL MODIFY statements into CREATE TABLE", () => {
    const result = squashSql([
      `
CREATE TABLE \`Thing\` (
  \`id\` INT NOT NULL,
  \`name\` VARCHAR(191) NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`Thing\` MODIFY \`name\` VARCHAR(191) NULL;
ALTER TABLE \`Thing\` MODIFY \`name\` VARCHAR(191) NULL;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `Thing`");
    expect(result.sql).toContain("`name` VARCHAR(191) NULL");
    expect(result.sql).not.toContain("ALTER TABLE `Thing` MODIFY");
  });

  test("removes MySQL FK teardown/rebuild intermediary DROP INDEX on created tables", () => {
    const result = squashSql([
      `
CREATE TABLE \`Parent\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`Child\` (
  \`id\` INT NOT NULL,
  \`parentId\` INT NOT NULL,
  CONSTRAINT \`Child_parentId_fkey\` FOREIGN KEY (\`parentId\`) REFERENCES \`Parent\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`Child\` DROP FOREIGN KEY \`Child_parentId_fkey\`;
DROP INDEX \`Child_parentId_fkey\` ON \`Child\`;
ALTER TABLE \`Child\` MODIFY \`parentId\` INT NULL;
ALTER TABLE \`Child\` ADD CONSTRAINT \`Child_parentId_fkey\` FOREIGN KEY (\`parentId\`) REFERENCES \`Parent\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `Child`");
    expect(result.sql).toContain("`parentId` INT NULL");
    expect(result.sql).toContain("ON DELETE SET NULL ON UPDATE CASCADE");
    expect(result.sql).not.toContain("DROP FOREIGN KEY");
    expect(result.sql).not.toContain("DROP INDEX `Child_parentId_fkey`");
    expect(result.sql).not.toContain("ALTER TABLE `Child`");
  });

  test("cancels orphaned MODIFY when ADD+DROP column pair cancels on pre-existing table", () => {
    const result = squashSql([
      `
ALTER TABLE \`User\` ADD COLUMN \`tempScore\` INT NOT NULL DEFAULT 0;
`,
      `
ALTER TABLE \`User\` MODIFY \`tempScore\` INT NULL;
`,
      `
ALTER TABLE \`User\` DROP COLUMN \`tempScore\`;
`,
    ]);

    expect(result.sql).toBe("");
    expect(result.removedStatements).toHaveLength(3);
  });

  test("deduplicates multiple ALTER COLUMN statements on the same column of a pre-existing table", () => {
    const result = squashSql([
      `
ALTER TABLE \`User\` ALTER COLUMN \`score\` SET DEFAULT 0;
`,
      `
ALTER TABLE \`User\` ALTER COLUMN \`score\` SET DEFAULT 100;
ALTER TABLE \`User\` ALTER COLUMN \`status\` SET NOT NULL;
`,
    ]);

    // Only the final ALTER for score should survive
    expect(result.sql).toContain("SET DEFAULT 100");
    expect(result.sql).not.toContain("SET DEFAULT 0");
    // Unrelated column on the same table is kept
    expect(result.sql).toContain("SET NOT NULL");
    expect(result.removedStatements).toHaveLength(1);
  });

  test("deduplicates multiple MODIFY statements on the same column of a pre-existing table", () => {
    const result = squashSql([
      `
ALTER TABLE \`AuditLog\` MODIFY \`resourceType\` ENUM('A', 'B') NOT NULL;
`,
      `
ALTER TABLE \`AuditLog\` MODIFY \`resourceType\` ENUM('A', 'B', 'C') NOT NULL;
ALTER TABLE \`AuditLog\` MODIFY \`otherCol\` VARCHAR(255) NULL;
`,
      `
ALTER TABLE \`AuditLog\` MODIFY \`resourceType\` ENUM('A', 'B', 'C', 'D') NOT NULL;
`,
    ]);

    // Only the final MODIFY for resourceType should survive
    expect(result.sql).toContain("ENUM('A', 'B', 'C', 'D')");
    expect(result.sql).not.toContain("ENUM('A', 'B', 'C') NOT NULL");
    expect(result.sql).not.toContain("ENUM('A', 'B') NOT NULL");
    // Unrelated column on the same table is kept
    expect(result.sql).toContain("`otherCol` VARCHAR(255) NULL");
    // Two intermediate statements removed, final + otherCol kept
    expect(result.removedStatements).toHaveLength(2);
  });

  test("removes inline CREATE TABLE indexes when later dropped", () => {
    const result = squashSql([
      `
CREATE TABLE \`Product\` (
  \`id\` INT NOT NULL,
  \`name\` VARCHAR(191) NOT NULL,
  INDEX \`Product_name_idx\`(\`name\`),
  PRIMARY KEY (\`id\`)
);
`,
      `
DROP INDEX \`Product_name_idx\` ON \`Product\`;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `Product`");
    expect(result.sql).not.toContain("Product_name_idx");
    expect(result.sql).not.toContain("DROP INDEX");
  });
});
