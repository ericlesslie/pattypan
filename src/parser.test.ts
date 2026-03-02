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
