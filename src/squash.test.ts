import { describe, expect, test } from "bun:test";
import type { Migration } from "./scanner";
import { squashMigrations, type SquashOptions } from "./squash";

function buildMigration(index: number, sql: string): Migration {
  const timestamp = `${20240101000000 + index}`;

  return {
    name: `${timestamp}_migration_${index}`,
    path: `/tmp/migration_${index}`,
    timestamp,
    sql,
  };
}

function squashSql(
  sqlStatements: string[],
  options?: SquashOptions
): ReturnType<typeof squashMigrations> {
  const migrations = sqlStatements.map((sql, index) => buildMigration(index + 1, sql));
  return squashMigrations(migrations, options);
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

  test("folds simple MySQL standalone indexes into CREATE TABLE", () => {
    const result = squashSql([
      `
CREATE TABLE \`FormSubmission\` (
  \`id\` INT NOT NULL,
  \`submittedAt\` DATETIME NULL,
  PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
`,
      `
CREATE INDEX \`FormSubmission_submittedAt_desc_idx\` ON \`FormSubmission\`(\`submittedAt\` DESC);
CREATE UNIQUE INDEX \`FormSubmission_submittedAt_key\` ON \`FormSubmission\`(\`submittedAt\`);
`,
    ]);

    expect(result.sql).toContain("INDEX `FormSubmission_submittedAt_desc_idx` (`submittedAt` DESC)");
    expect(result.sql).toContain("UNIQUE INDEX `FormSubmission_submittedAt_key` (`submittedAt`)");
    expect(result.sql).not.toContain(
      "CREATE INDEX `FormSubmission_submittedAt_desc_idx` ON `FormSubmission`"
    );
    expect(result.sql).not.toContain(
      "CREATE UNIQUE INDEX `FormSubmission_submittedAt_key` ON `FormSubmission`"
    );
  });

  test("drops standalone MySQL unique indexes that duplicate the primary key", () => {
    const result = squashSql([
      `
CREATE TABLE \`APIKey\` (
  \`userId\` INT NOT NULL,
  PRIMARY KEY (\`userId\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
`,
      `
CREATE UNIQUE INDEX \`APIKey_userId_key\` ON \`APIKey\`(\`userId\`);
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `APIKey`");
    expect(result.sql).not.toContain("APIKey_userId_key");
    expect(result.sql).not.toContain("CREATE UNIQUE INDEX `APIKey_userId_key`");
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
    expect(result.sql).toContain(
      "CONSTRAINT `Child_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Parent` (`id`) ON DELETE SET NULL ON UPDATE CASCADE"
    );
    expect(result.sql).not.toContain("DROP FOREIGN KEY");
    expect(result.sql).not.toContain("DROP INDEX `Child_parentId_fkey`");
    expect(result.sql).not.toContain("ALTER TABLE `Child` ADD CONSTRAINT `Child_parentId_fkey`");
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

  // Issue 1 / Issue 5: DROP_COLUMN removes orphaned indexes and FK from CREATE TABLE
  test("removes orphan indexes and FKs after DROP_COLUMN on squash-owned table", () => {
    const result = squashSql([
      `
CREATE TABLE \`Location\` (
  \`id\` INT NOT NULL,
  \`catalog_id\` INT,
  \`company_id\` INT,
  INDEX \`Location_catalog_idx\`(\`catalog_id\`),
  CONSTRAINT \`Location_company_fkey\` FOREIGN KEY (\`company_id\`) REFERENCES \`Company\`(\`id\`),
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`Location\` DROP COLUMN \`catalog_id\`;
ALTER TABLE \`Location\` DROP COLUMN \`company_id\`;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `Location`");
    // The dropped columns' index and FK must be gone
    expect(result.sql).not.toContain("catalog_id");
    expect(result.sql).not.toContain("Location_catalog_idx");
    expect(result.sql).not.toContain("company_id");
    expect(result.sql).not.toContain("Location_company_fkey");
    // No stray ALTER TABLE statements
    expect(result.sql).not.toContain("ALTER TABLE");
  });

  // Issue 2: DROP FOREIGN KEY on squash-owned table that never had the FK is a no-op
  test("removes DROP FOREIGN KEY that targets a constraint never created in squash range", () => {
    const result = squashSql([
      `
CREATE TABLE \`Location\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`Location\` DROP FOREIGN KEY \`Location_ibfk_1\`;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `Location`");
    // The DROP FOREIGN KEY must be removed, not passed through
    expect(result.sql).not.toContain("DROP FOREIGN KEY");
    expect(result.removedStatements.some((s) => s.reason.includes("no-op"))).toBe(true);
  });

  // Issue 3: UPDATE against a transient table is removed
  test("removes UPDATE statement targeting a table created then dropped in squash range", () => {
    const result = squashSql([
      `
CREATE TABLE \`Product\` (
  \`id\` INT NOT NULL,
  \`status\` VARCHAR(50) NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
      `
UPDATE \`Product\` SET \`status\` = 'active';
`,
      `
DROP TABLE \`Product\`;
`,
    ]);

    expect(result.sql).not.toContain("CREATE TABLE `Product`");
    expect(result.sql).not.toContain("UPDATE");
    expect(result.sql).not.toContain("DROP TABLE");
  });

  test("keeps non-transient DML by default", () => {
    const result = squashSql([
      `
CREATE TABLE \`User\` (
  \`id\` INT NOT NULL,
  \`email\` VARCHAR(191) NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
      `
UPDATE \`User\` SET \`email\` = 'user@example.com';
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `User`");
    expect(result.sql).toContain("UPDATE `User` SET `email` = 'user@example.com'");
  });

  test("removes INSERT, UPDATE, and DELETE when removeDml is enabled", () => {
    const result = squashSql(
      [
        `
CREATE TABLE \`User\` (
  \`id\` INT NOT NULL,
  \`email\` VARCHAR(191) NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
        `
INSERT INTO \`User\` (\`id\`, \`email\`) VALUES (1, 'first@example.com');
UPDATE \`User\` SET \`email\` = 'user@example.com';
DELETE FROM \`User\` WHERE \`id\` = 1;
`,
      ],
      { removeDml: true }
    );

    expect(result.sql).toContain("CREATE TABLE `User`");
    expect(result.sql).not.toContain("INSERT INTO `User`");
    expect(result.sql).not.toContain("UPDATE `User`");
    expect(result.sql).not.toContain("DELETE FROM `User`");
    expect(
      result.removedStatements.filter((entry) => entry.reason === "Removed by DML removal option")
    ).toHaveLength(3);
  });

  test("still removes transient-table DML when removeDml is enabled", () => {
    const result = squashSql(
      [
        `
CREATE TABLE \`Product\` (
  \`id\` INT NOT NULL,
  \`status\` VARCHAR(50) NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
        `
UPDATE \`Product\` SET \`status\` = 'active';
`,
        `
DROP TABLE \`Product\`;
`,
      ],
      { removeDml: true }
    );

    expect(result.sql).not.toContain("CREATE TABLE `Product`");
    expect(result.sql).not.toContain("UPDATE");
    expect(result.sql).not.toContain("DROP TABLE");
  });

  test("removes # comment prefixes before DML removal classification", () => {
    const result = squashSql(
      [
        `
CREATE TABLE \`Location\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
        `
# backfill org ids
UPDATE \`Location\` SET \`id\` = 1;
`,
      ],
      { removeDml: true }
    );

    expect(result.sql).toContain("CREATE TABLE `Location`");
    expect(result.sql).not.toContain("UPDATE `Location`");
    expect(
      result.removedStatements.some((entry) => entry.reason === "Removed by DML removal option")
    ).toBe(true);
  });

  // Issue 4: RENAME_COLUMN updates column references inside inline indexes
  test("propagates RENAME_COLUMN into inline UNIQUE INDEX on squash-owned table", () => {
    const result = squashSql([
      `
CREATE TABLE \`APIKey\` (
  \`id\` INT NOT NULL,
  \`user_id\` INT NOT NULL,
  UNIQUE INDEX \`APIKey_user_id_key\`(\`user_id\`),
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`APIKey\` RENAME COLUMN \`user_id\` TO \`userId\`;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `APIKey`");
    // Index must reference the new column name in its column list
    expect(result.sql).toContain("APIKey_user_id_key");
    expect(result.sql).toContain("(`userId`)");
    // Old column name must not appear as a column reference
    expect(result.sql).not.toContain("(`user_id`)");
    // No stray ALTER TABLE
    expect(result.sql).not.toContain("ALTER TABLE");
  });

  // Issue 5: join-table column renames propagate into the B index
  test("propagates RENAME_COLUMN into join-table index on squash-owned table", () => {
    const result = squashSql([
      `
CREATE TABLE \`_LocationToLocationAttribute\` (
  \`A\` INT NOT NULL,
  \`B\` INT NOT NULL,
  INDEX \`_LocationToLocationAttribute_B_index\`(\`B\`),
  PRIMARY KEY (\`A\`, \`B\`)
);
`,
      `
ALTER TABLE \`_LocationToLocationAttribute\` RENAME COLUMN \`A\` TO \`locationId\`;
ALTER TABLE \`_LocationToLocationAttribute\` RENAME COLUMN \`B\` TO \`attributeId\`;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `_LocationToLocationAttribute`");
    // Index must reference attributeId, not the old B
    expect(result.sql).toContain("attributeId");
    expect(result.sql).toContain("_LocationToLocationAttribute_B_index");
    expect(result.sql).not.toContain("`B`");
    expect(result.sql).not.toContain("`A`");
    // No stray ALTER TABLE
    expect(result.sql).not.toContain("ALTER TABLE");
  });

  test("reorders acyclic forward foreign keys and inlines them", () => {
    const result = squashSql([
      `
CREATE TABLE \`Child\` (
  \`id\` INT NOT NULL,
  \`parentId\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`Parent\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`Child\`
  ADD CONSTRAINT \`Child_parentId_fkey\`
  FOREIGN KEY (\`parentId\`) REFERENCES \`Parent\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
`,
    ]);

    const childCreateIndex = result.sql.indexOf("CREATE TABLE `Child`");
    const parentCreateIndex = result.sql.indexOf("CREATE TABLE `Parent`");

    expect(parentCreateIndex).toBeGreaterThanOrEqual(0);
    expect(childCreateIndex).toBeGreaterThan(parentCreateIndex);
    expect(result.sql).toContain("CONSTRAINT `Child_parentId_fkey` FOREIGN KEY (`parentId`)");
    expect(result.sql).toContain("REFERENCES `Parent` (`id`)");
    expect(result.sql).not.toContain("ALTER TABLE `Child` ADD CONSTRAINT `Child_parentId_fkey`");
  });

  test("defers only the cycle-breaking foreign key in a two-table cycle", () => {
    const result = squashSql([
      `
CREATE TABLE \`A\` (
  \`id\` INT NOT NULL,
  \`bId\` INT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`B\` (
  \`id\` INT NOT NULL,
  \`aId\` INT NULL,
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`A\`
  ADD CONSTRAINT \`A_bId_fkey\`
  FOREIGN KEY (\`bId\`) REFERENCES \`B\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE \`B\`
  ADD CONSTRAINT \`B_aId_fkey\`
  FOREIGN KEY (\`aId\`) REFERENCES \`A\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE;
`,
    ]);

    const deferredStatements =
      result.sql.match(/ALTER TABLE `[^`]+` ADD CONSTRAINT `[^`]+_fkey`/g) ?? [];

    expect(deferredStatements).toHaveLength(1);
    expect(result.sql).toContain("ALTER TABLE `A` ADD CONSTRAINT `A_bId_fkey`");
    expect(result.sql).not.toContain("ALTER TABLE `B` ADD CONSTRAINT `B_aId_fkey`");
    expect(result.sql).toContain("CONSTRAINT `B_aId_fkey` FOREIGN KEY (`aId`) REFERENCES `A` (`id`)");
    expect(result.sql).toContain("ALTER TABLE `A` ADD CONSTRAINT `A_bId_fkey`");
  });

  test("topologically sorts an acyclic foreign-key chain and inlines all edges", () => {
    const result = squashSql([
      `
CREATE TABLE \`Grandchild\` (
  \`id\` INT NOT NULL,
  \`childId\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`Child\` (
  \`id\` INT NOT NULL,
  \`parentId\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`Parent\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`Grandchild\` ADD CONSTRAINT \`Grandchild_childId_fkey\` FOREIGN KEY (\`childId\`) REFERENCES \`Child\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE \`Child\` ADD CONSTRAINT \`Child_parentId_fkey\` FOREIGN KEY (\`parentId\`) REFERENCES \`Parent\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
`,
    ]);

    const parentCreateIndex = result.sql.indexOf("CREATE TABLE `Parent`");
    const childCreateIndex = result.sql.indexOf("CREATE TABLE `Child`");
    const grandchildCreateIndex = result.sql.indexOf("CREATE TABLE `Grandchild`");

    expect(parentCreateIndex).toBeGreaterThanOrEqual(0);
    expect(childCreateIndex).toBeGreaterThan(parentCreateIndex);
    expect(grandchildCreateIndex).toBeGreaterThan(childCreateIndex);
    expect(result.sql).toContain("CONSTRAINT `Child_parentId_fkey` FOREIGN KEY (`parentId`)");
    expect(result.sql).toContain("CONSTRAINT `Grandchild_childId_fkey` FOREIGN KEY (`childId`)");
    expect(result.sql).not.toContain("ALTER TABLE `Child` ADD CONSTRAINT");
    expect(result.sql).not.toContain("ALTER TABLE `Grandchild` ADD CONSTRAINT");
  });

  test("keeps a spanning set of foreign keys inline inside larger cycles", () => {
    const result = squashSql([
      `
CREATE TABLE \`A\` (
  \`id\` INT NOT NULL,
  \`cId\` INT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`B\` (
  \`id\` INT NOT NULL,
  \`aId\` INT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`C\` (
  \`id\` INT NOT NULL,
  \`bId\` INT NULL,
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`A\` ADD CONSTRAINT \`A_cId_fkey\` FOREIGN KEY (\`cId\`) REFERENCES \`C\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE \`B\` ADD CONSTRAINT \`B_aId_fkey\` FOREIGN KEY (\`aId\`) REFERENCES \`A\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE \`C\` ADD CONSTRAINT \`C_bId_fkey\` FOREIGN KEY (\`bId\`) REFERENCES \`B\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE;
`,
    ]);

    const deferredStatements =
      result.sql.match(/ALTER TABLE `[^`]+` ADD CONSTRAINT `[^`]+_fkey`/g) ?? [];

    expect(deferredStatements).toHaveLength(1);
    expect(result.sql).toContain("ALTER TABLE `A` ADD CONSTRAINT `A_cId_fkey`");
    expect(result.sql).not.toContain("ALTER TABLE `B` ADD CONSTRAINT `B_aId_fkey`");
    expect(result.sql).not.toContain("ALTER TABLE `C` ADD CONSTRAINT `C_bId_fkey`");
    expect(result.sql).toContain("CONSTRAINT `B_aId_fkey` FOREIGN KEY (`aId`) REFERENCES `A` (`id`)");
    expect(result.sql).toContain("CONSTRAINT `C_bId_fkey` FOREIGN KEY (`bId`) REFERENCES `B` (`id`)");
  });

  test("removes inline unique index after rename-index and drop-index chain", () => {
    const result = squashSql([
      `
CREATE TABLE \`User\` (
  \`id\` INT NOT NULL,
  \`email\` VARCHAR(191) NULL,
  UNIQUE INDEX \`User.email_unique\`(\`email\`),
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`User\` RENAME INDEX \`User.email_unique\` TO \`User_email_key\`;
`,
      `
DROP INDEX \`User_email_key\` ON \`User\`;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `User`");
    expect(result.sql).not.toContain("User.email_unique");
    expect(result.sql).not.toContain("User_email_key");
    expect(result.sql).not.toContain("RENAME INDEX");
    expect(result.sql).not.toContain("DROP INDEX");
  });

  test("drops MySQL unique indexes when DROP CONSTRAINT targets the index name", () => {
    const result = squashSql([
      `
CREATE TABLE \`AssignmentTriggerAction\` (
  \`id\` INT NOT NULL,
  \`triggerId\` INT NOT NULL,
  UNIQUE INDEX \`AssignmentTriggerAction_triggerId_key\`(\`triggerId\`),
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`AssignmentTriggerAction\` DROP CONSTRAINT \`AssignmentTriggerAction_triggerId_key\`;
ALTER TABLE \`AssignmentTriggerAction\` ADD UNIQUE INDEX \`AssignmentTriggerAction_triggerId_triggerRevisionId_key\` (\`triggerId\`);
`,
    ]);

    expect(result.sql).not.toContain("AssignmentTriggerAction_triggerId_key");
    expect(result.sql).toContain("AssignmentTriggerAction_triggerId_triggerRevisionId_key");
  });

  test("folds RENAME TO into the final CREATE TABLE name and referenced foreign keys", () => {
    const result = squashSql([
      `
CREATE TABLE \`_LocationToLocationAttribute\` (
  \`locationId\` INT NOT NULL,
  \`attributeId\` INT NOT NULL,
  PRIMARY KEY (\`locationId\`, \`attributeId\`)
);

CREATE TABLE \`LocationAttributeUsage\` (
  \`id\` INT NOT NULL,
  \`joinLocationId\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`LocationAttributeUsage\`
  ADD CONSTRAINT \`LocationAttributeUsage_joinLocationId_fkey\`
  FOREIGN KEY (\`joinLocationId\`) REFERENCES \`_LocationToLocationAttribute\`(\`locationId\`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE \`_LocationToLocationAttribute\` RENAME TO \`LocationToAttribute\`;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `LocationToAttribute`");
    expect(result.sql).not.toContain("CREATE TABLE `_LocationToLocationAttribute`");
    expect(result.sql).not.toContain("ALTER TABLE `_LocationToLocationAttribute` RENAME TO");
    expect(result.sql).toContain("REFERENCES `LocationToAttribute` (`locationId`)");
  });

  test("propagates renamed join-table state into later folded PK and FK additions", () => {
    const result = squashSql([
      `
CREATE TABLE \`Location\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE \`LocationAttribute\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE \`_LocationToLocationAttribute\` (
  \`locationId\` INT NOT NULL,
  \`attributeId\` INT NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
`,
      `
ALTER TABLE \`_LocationToLocationAttribute\`
  RENAME TO \`LocationToAttribute\`,
  ADD PRIMARY KEY (\`locationId\`, \`attributeId\`),
  ADD CONSTRAINT \`LocationToAttribute_locationId_fkey\` FOREIGN KEY (\`locationId\`) REFERENCES \`Location\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT \`LocationToAttribute_attributeId_fkey\` FOREIGN KEY (\`attributeId\`) REFERENCES \`LocationAttribute\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `LocationToAttribute`");
    expect(result.sql).toContain("PRIMARY KEY (`locationId`, `attributeId`)");
    expect(result.sql).toContain(
      "CONSTRAINT `LocationToAttribute_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `Location` (`id`) ON DELETE CASCADE ON UPDATE CASCADE"
    );
    expect(result.sql).toContain(
      "CONSTRAINT `LocationToAttribute_attributeId_fkey` FOREIGN KEY (`attributeId`) REFERENCES `LocationAttribute` (`id`) ON DELETE CASCADE ON UPDATE CASCADE"
    );
    expect(result.sql).not.toContain("_LocationToLocationAttribute");
  });

  test("handles Prisma-style MySQL squash regressions together", () => {
    const result = squashSql([
      `
CREATE TABLE \`Organization\` (
  \`id\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`User\` (
  \`id\` INT NOT NULL,
  \`email\` VARCHAR(191) NULL,
  UNIQUE INDEX \`User.email_unique\`(\`email\`),
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`_LocationToLocationAttribute\` (
  \`locationId\` INT NOT NULL,
  \`attributeId\` INT NOT NULL,
  PRIMARY KEY (\`locationId\`, \`attributeId\`)
);

CREATE TABLE \`Location\` (
  \`id\` INT NOT NULL,
  \`orgId\` INT NOT NULL,
  PRIMARY KEY (\`id\`)
);

CREATE TABLE \`AssignmentTriggerAction\` (
  \`id\` INT NOT NULL,
  \`triggerId\` INT NOT NULL,
  UNIQUE INDEX \`AssignmentTriggerAction_triggerId_key\`(\`triggerId\`),
  PRIMARY KEY (\`id\`)
);
`,
      `
ALTER TABLE \`Location\` ADD CONSTRAINT \`Location_orgId_fkey\` FOREIGN KEY (\`orgId\`) REFERENCES \`Organization\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE \`User\` RENAME INDEX \`User.email_unique\` TO \`User_email_key\`;
DROP INDEX \`User_email_key\` ON \`User\`;
ALTER TABLE \`AssignmentTriggerAction\` DROP CONSTRAINT \`AssignmentTriggerAction_triggerId_key\`;
ALTER TABLE \`_LocationToLocationAttribute\` RENAME TO \`LocationToAttribute\`;
# backfill org ids
UPDATE \`Location\` SET \`orgId\` = 1;
`,
    ]);

    expect(result.sql).toContain("CREATE TABLE `LocationToAttribute`");
    expect(result.sql).not.toContain("User.email_unique");
    expect(result.sql).not.toContain("User_email_key");
    expect(result.sql).not.toContain("AssignmentTriggerAction_triggerId_key");
    expect(result.sql).toContain(
      "CONSTRAINT `Location_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization` (`id`) ON DELETE CASCADE ON UPDATE CASCADE"
    );
    expect(result.sql).not.toContain(
      "ALTER TABLE `Location` ADD CONSTRAINT `Location_orgId_fkey`"
    );
    expect(result.sql).toContain("UPDATE `Location` SET `orgId` = 1");
  });
});
