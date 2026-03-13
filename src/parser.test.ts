import { describe, expect, test } from "bun:test";
import { parseSQL, splitStatements } from "./parser";

describe("parser", () => {
  test("classifies ALTER TABLE DROP INDEX correctly", () => {
    const parsed = parseSQL('ALTER TABLE `User` DROP INDEX `User_email_idx`;');

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("ALTER_TABLE");
    expect(parsed[0]?.alterOperation).toBe("DROP_INDEX");
    expect(parsed[0]?.index).toBe("User_email_idx");
  });

  test("classifies ALTER TABLE ADD UNIQUE INDEX correctly", () => {
    const parsed = parseSQL(
      'ALTER TABLE `User` ADD UNIQUE INDEX `User_email_idx` (`email`);'
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("ALTER_TABLE");
    expect(parsed[0]?.alterOperation).toBe("ADD_INDEX");
    expect(parsed[0]?.index).toBe("User_email_idx");
  });

  test("classifies ALTER TABLE MODIFY COLUMN correctly", () => {
    const parsed = parseSQL('ALTER TABLE `User` MODIFY `email` VARCHAR(191) NULL;');

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("ALTER_TABLE");
    expect(parsed[0]?.alterOperation).toBe("MODIFY_COLUMN");
    expect(parsed[0]?.column).toBe("email");
  });

  test("classifies ALTER TABLE RENAME INDEX correctly", () => {
    const parsed = parseSQL(
      "ALTER TABLE `User` RENAME INDEX `User.email_unique` TO `User_email_key`;"
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("ALTER_TABLE");
    expect(parsed[0]?.alterOperation).toBe("RENAME_INDEX");
    expect(parsed[0]?.index).toBe("User.email_unique");
  });

  test("classifies ALTER TABLE RENAME TO correctly", () => {
    const parsed = parseSQL(
      "ALTER TABLE `_LocationToLocationAttribute` RENAME TO `LocationToAttribute`;"
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("ALTER_TABLE");
    expect(parsed[0]?.alterOperation).toBe("RENAME_TABLE");
    expect(parsed[0]?.table).toBe("_LocationToLocationAttribute");
  });

  test("classifies DML statements and preserves target tables", () => {
    const parsed = parseSQL(`
INSERT INTO \`User\` (\`id\`) VALUES (1);
UPDATE \`User\` SET \`email\` = 'user@example.com';
DELETE FROM \`User\` WHERE \`id\` = 1;
`);

    expect(parsed).toHaveLength(3);
    expect(parsed.map((statement) => statement.type)).toEqual([
      "INSERT",
      "UPDATE",
      "DELETE",
    ]);
    expect(parsed.map((statement) => statement.table)).toEqual([
      "User",
      "User",
      "User",
    ]);
  });

  test("strips inline -- comments from SQL", () => {
    const sql = `
ALTER TABLE \`User\` MODIFY \`email\` VARCHAR(191) NULL; -- was NOT NULL
ALTER TABLE \`User\` MODIFY \`name\` VARCHAR(100) NOT NULL; -- added in v2
`;
    const parsed = parseSQL(sql);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.raw).not.toContain("--");
    expect(parsed[1]?.raw).not.toContain("--");
  });

  test("does not strip -- inside string literals", () => {
    const sql = `ALTER TABLE \`Log\` MODIFY \`message\` VARCHAR(500) NOT NULL DEFAULT 'no -- error';`;
    const parsed = parseSQL(sql);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.raw).toContain("'no -- error'");
  });

  test("strips inline # comments from SQL", () => {
    const sql = `
ALTER TABLE \`User\` MODIFY \`email\` VARCHAR(191) NULL; # was NOT NULL
UPDATE \`User\` SET \`email\` = 'user@example.com'; # backfill
`;
    const parsed = parseSQL(sql);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.raw).not.toContain("#");
    expect(parsed[1]?.raw).not.toContain("#");
  });

  test("does not strip # inside string literals and still detects DML", () => {
    const sql = `
# comment before update
UPDATE \`User\` SET \`email\` = 'user#1@example.com';
`;
    const parsed = parseSQL(sql);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("UPDATE");
    expect(parsed[0]?.table).toBe("User");
    expect(parsed[0]?.raw).toContain("'user#1@example.com'");
  });

  test("does not split semicolons inside dollar-quoted blocks", () => {
    const sql = `
CREATE FUNCTION foo() RETURNS void AS $$
BEGIN
  RAISE NOTICE 'x';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE "User" (
  "id" TEXT
);
`;

    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("CREATE FUNCTION foo()");
    expect(statements[1]).toContain('CREATE TABLE "User"');
  });
});
