export type StatementType =
  | "CREATE_TABLE"
  | "DROP_TABLE"
  | "ALTER_TABLE"
  | "CREATE_INDEX"
  | "DROP_INDEX"
  | "CREATE_ENUM"
  | "ALTER_ENUM"
  | "DROP_ENUM"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "OTHER";

export type DmlStatementType = "INSERT" | "UPDATE" | "DELETE";

export type AlterOperation =
  | "ADD_COLUMN"
  | "DROP_COLUMN"
  | "ALTER_COLUMN"
  | "MODIFY_COLUMN"
  | "RENAME_COLUMN"
  | "RENAME_INDEX"
  | "RENAME_TABLE"
  | "ADD_CONSTRAINT"
  | "DROP_CONSTRAINT"
  | "ADD_INDEX"
  | "DROP_INDEX"
  | "OTHER";

export interface ParsedStatement {
  type: StatementType;
  raw: string;
  table?: string;
  column?: string;
  index?: string;
  enumName?: string;
  alterOperation?: AlterOperation;
  constraintName?: string;
}

const IDENTIFIER_SEGMENT = `(?:["\`']?\\w+["\`']?)`;
const QUALIFIED_IDENTIFIER = `${IDENTIFIER_SEGMENT}(?:\\.${IDENTIFIER_SEGMENT})*`;

function normalizeWhitespace(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function extractAlterTableClause(sql: string): string {
  const normalized = normalizeWhitespace(sql);
  const match = normalized.match(
    new RegExp(`^ALTER\\s+TABLE\\s+${QUALIFIED_IDENTIFIER}\\s+(.+)$`, "i")
  );

  return (match?.[1] ?? normalized).trim();
}

function matchDollarQuoteDelimiter(sql: string, offset: number): string | undefined {
  const remaining = sql.slice(offset);
  const match = remaining.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0];
}

function extractLastIdentifier(qualifiedName: string): string | undefined {
  const parts = qualifiedName.split(".");
  const last = parts[parts.length - 1]?.trim();
  if (!last) return undefined;
  return last.replace(/^["`']|["`']$/g, "");
}

/**
 * Remove block comments from SQL (/* ... *\/)
 * Preserves the structure of the SQL while removing comment blocks
 */
function stripBlockComments(sql: string): string {
  let result = "";
  let i = 0;

  while (i < sql.length) {
    // Check for start of block comment
    if (sql[i] === "/" && sql[i + 1] === "*") {
      // Find the end of the comment
      let j = i + 2;
      while (j < sql.length - 1) {
        if (sql[j] === "*" && sql[j + 1] === "/") {
          i = j + 2;
          break;
        }
        j++;
      }
      // If we didn't find closing, skip to end
      if (j >= sql.length - 1) {
        break;
      }
    } else {
      result += sql[i];
      i++;
    }
  }

  return result;
}

function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      let inString = false;
      let stringChar = "";
      for (let i = 0; i < line.length; i++) {
        const char = line[i] ?? "";
        if (!inString && (char === "'" || char === '"' || char === "`")) {
          inString = true;
          stringChar = char;
        } else if (inString && char === stringChar) {
          inString = false;
        } else if (!inString && char === "-" && (line[i + 1] ?? "") === "-") {
          return line.slice(0, i).trimEnd();
        } else if (!inString && char === "#") {
          return line.slice(0, i).trimEnd();
        }
      }
      return line;
    })
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function extractTableName(sql: string): string | undefined {
  // CREATE TABLE "tableName" or CREATE TABLE tableName
  const createMatch = sql.match(
    new RegExp(
      `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_IDENTIFIER})`,
      "i"
    )
  );
  if (createMatch?.[1]) return extractLastIdentifier(createMatch[1]);

  // DROP TABLE "tableName"
  const dropMatch = sql.match(
    new RegExp(
      `DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${QUALIFIED_IDENTIFIER})`,
      "i"
    )
  );
  if (dropMatch?.[1]) return extractLastIdentifier(dropMatch[1]);

  // ALTER TABLE "tableName"
  const alterMatch = sql.match(
    new RegExp(`ALTER\\s+TABLE\\s+(${QUALIFIED_IDENTIFIER})`, "i")
  );
  if (alterMatch?.[1]) return extractLastIdentifier(alterMatch[1]);

  // UPDATE `tableName` SET ...
  const updateMatch = sql.match(
    new RegExp(`^\\s*UPDATE\\s+(?:LOW_PRIORITY\\s+)?(?:IGNORE\\s+)?(${QUALIFIED_IDENTIFIER})`, "i")
  );
  if (updateMatch?.[1]) return extractLastIdentifier(updateMatch[1]);

  // DELETE FROM `tableName`
  const deleteMatch = sql.match(
    new RegExp(`^\\s*DELETE\\s+FROM\\s+(${QUALIFIED_IDENTIFIER})`, "i")
  );
  if (deleteMatch?.[1]) return extractLastIdentifier(deleteMatch[1]);

  // INSERT INTO `tableName`
  const insertMatch = sql.match(
    new RegExp(`^\\s*INSERT\\s+(?:INTO\\s+)?(${QUALIFIED_IDENTIFIER})`, "i")
  );
  if (insertMatch?.[1]) return extractLastIdentifier(insertMatch[1]);

  return undefined;
}

function extractColumnName(sql: string): string | undefined {
  const clause = extractAlterTableClause(sql);

  // ADD COLUMN "columnName" or ADD "columnName"
  const addMatch = clause.match(
    /ADD\s+(?:COLUMN\s+)?[""`]?(\w+)[""`]?\s+(?!CONSTRAINT)/i
  );
  if (addMatch) return addMatch[1];

  // DROP COLUMN "columnName"
  const dropMatch = clause.match(/DROP\s+(?:COLUMN\s+)?[""`]?(\w+)[""`]?/i);
  if (dropMatch) return dropMatch[1];

  // ALTER COLUMN "columnName"
  const alterMatch = clause.match(/ALTER\s+(?:COLUMN\s+)?[""`]?(\w+)[""`]?/i);
  if (alterMatch) return alterMatch[1];

  // MODIFY COLUMN "columnName" (MySQL)
  const modifyMatch = clause.match(/MODIFY\s+(?:COLUMN\s+)?[""`]?(\w+)[""`]?/i);
  if (modifyMatch) return modifyMatch[1];

  // RENAME COLUMN "old" TO "new"
  const renameMatch = clause.match(
    /RENAME\s+(?:COLUMN\s+)?[""`]?(\w+)[""`]?\s+TO/i
  );
  if (renameMatch) return renameMatch[1];

  return undefined;
}

function extractIndexName(sql: string): string | undefined {
  // CREATE INDEX "indexName" or CREATE UNIQUE INDEX "indexName"
  const createMatch = sql.match(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[""`]?([\w.]+)[""`]?/i
  );
  if (createMatch) return createMatch[1];

  // DROP INDEX "indexName"
  const dropMatch = sql.match(
    /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?[""`]?([\w.]+)[""`]?/i
  );
  if (dropMatch) return dropMatch[1];

  return undefined;
}

function extractAlterIndexName(sql: string): string | undefined {
  // ALTER TABLE ... ADD INDEX "indexName"
  const addMatch = sql.match(
    /ADD\s+(?:UNIQUE\s+)?INDEX\s+[""`]?([\w.]+)[""`]?/i
  );
  if (addMatch) return addMatch[1];

  // ALTER TABLE ... DROP INDEX "indexName"
  const dropMatch = sql.match(/DROP\s+INDEX\s+[""`]?([\w.]+)[""`]?/i);
  if (dropMatch) return dropMatch[1];

  // ALTER TABLE ... RENAME INDEX "oldName" TO "newName"
  const renameMatch = sql.match(
    /RENAME\s+INDEX\s+[""`]?([\w.]+)[""`]?\s+TO\s+[""`]?[\w.]+[""`]?/i
  );
  if (renameMatch) return renameMatch[1];

  return undefined;
}

function extractEnumName(sql: string): string | undefined {
  // CREATE TYPE "enumName" AS ENUM
  const createMatch = sql.match(
    /CREATE\s+TYPE\s+[""`]?(\w+)[""`]?\s+AS\s+ENUM/i
  );
  if (createMatch) return createMatch[1];

  // DROP TYPE "enumName"
  const dropMatch = sql.match(
    /DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?[""`]?(\w+)[""`]?/i
  );
  if (dropMatch) return dropMatch[1];

  // ALTER TYPE "enumName"
  const alterMatch = sql.match(/ALTER\s+TYPE\s+[""`]?(\w+)[""`]?/i);
  if (alterMatch) return alterMatch[1];

  return undefined;
}

function extractConstraintName(sql: string): string | undefined {
  // ADD CONSTRAINT "constraintName"
  const addMatch = sql.match(/ADD\s+CONSTRAINT\s+[""`]?([\w.]+)[""`]?/i);
  if (addMatch) return addMatch[1];

  // DROP CONSTRAINT "constraintName"
  const dropMatch = sql.match(/DROP\s+CONSTRAINT\s+[""`]?([\w.]+)[""`]?/i);
  if (dropMatch) return dropMatch[1];

  // DROP FOREIGN KEY "constraintName" (MySQL syntax)
  const dropFkMatch = sql.match(/DROP\s+FOREIGN\s+KEY\s+[""`]?([\w.]+)[""`]?/i);
  if (dropFkMatch) return dropFkMatch[1];

  // ADD FOREIGN KEY (implicit constraint name from CONSTRAINT keyword)
  const addFkConstraint = sql.match(
    /ADD\s+CONSTRAINT\s+[""`]?([\w.]+)[""`]?\s+FOREIGN\s+KEY/i
  );
  if (addFkConstraint) return addFkConstraint[1];

  return undefined;
}

function determineStatementType(sql: string): StatementType {
  const normalized = normalizeWhitespace(sql).toUpperCase();

  if (normalized.startsWith("CREATE TABLE")) return "CREATE_TABLE";
  if (normalized.startsWith("DROP TABLE")) return "DROP_TABLE";
  if (normalized.startsWith("ALTER TABLE")) return "ALTER_TABLE";
  if (normalized.match(/^CREATE\s+(UNIQUE\s+)?INDEX/)) return "CREATE_INDEX";
  if (normalized.startsWith("DROP INDEX")) return "DROP_INDEX";
  if (normalized.match(/^CREATE\s+TYPE.*AS\s+ENUM/)) return "CREATE_ENUM";
  if (normalized.startsWith("ALTER TYPE")) return "ALTER_ENUM";
  if (normalized.startsWith("DROP TYPE")) return "DROP_ENUM";
  if (normalized.match(/^INSERT\b/)) return "INSERT";
  if (normalized.match(/^UPDATE\b/)) return "UPDATE";
  if (normalized.match(/^DELETE\b/)) return "DELETE";

  return "OTHER";
}

export function isDmlStatementType(type: StatementType): type is DmlStatementType {
  return type === "INSERT" || type === "UPDATE" || type === "DELETE";
}

export function isDmlStatement(statement: Pick<ParsedStatement, "type">): boolean {
  return isDmlStatementType(statement.type);
}

function determineAlterOperation(sql: string): AlterOperation {
  const normalized = extractAlterTableClause(sql).toUpperCase();

  if (normalized.match(/\bADD\s+(UNIQUE\s+)?INDEX\b/)) return "ADD_INDEX";
  if (normalized.match(/\bDROP\s+INDEX\b/)) return "DROP_INDEX";
  if (normalized.includes("RENAME INDEX")) return "RENAME_INDEX";
  if (normalized.includes("ADD CONSTRAINT")) return "ADD_CONSTRAINT";
  if (normalized.includes("DROP CONSTRAINT")) return "DROP_CONSTRAINT";
  // MySQL uses DROP FOREIGN KEY instead of DROP CONSTRAINT
  if (normalized.includes("DROP FOREIGN KEY")) return "DROP_CONSTRAINT";
  if (normalized.includes("ADD PRIMARY KEY")) return "ADD_CONSTRAINT";
  if (normalized.includes("ADD UNIQUE")) return "ADD_CONSTRAINT";
  if (normalized.includes("ADD FOREIGN KEY")) return "ADD_CONSTRAINT";
  if (normalized.includes("ADD CHECK")) return "ADD_CONSTRAINT";
  if (normalized.includes("DROP PRIMARY KEY")) return "DROP_CONSTRAINT";
  if (normalized.match(/\bRENAME\s+TO\b/)) return "RENAME_TABLE";
  if (normalized.match(/ADD\s+(COLUMN\s+)?["`]?\w+["`]?\s+/)) return "ADD_COLUMN";
  if (normalized.match(/DROP\s+(COLUMN\s+)?["`]?\w+["`]?/)) return "DROP_COLUMN";
  if (normalized.match(/MODIFY\s+(COLUMN\s+)?["`]?\w+["`]?\s+/)) return "MODIFY_COLUMN";
  if (normalized.match(/ALTER\s+(COLUMN\s+)?["`]?\w+["`]?/)) return "ALTER_COLUMN";
  if (normalized.includes("RENAME COLUMN")) return "RENAME_COLUMN";

  return "OTHER";
}

export function parseStatement(sql: string): ParsedStatement {
  const type = determineStatementType(sql);
  const result: ParsedStatement = {
    type,
    raw: sql.trim(),
  };

  switch (type) {
    case "CREATE_TABLE":
    case "DROP_TABLE":
      result.table = extractTableName(sql);
      break;

    case "ALTER_TABLE":
      result.table = extractTableName(sql);
      result.alterOperation = determineAlterOperation(sql);
      if (
        result.alterOperation === "ADD_COLUMN" ||
        result.alterOperation === "DROP_COLUMN" ||
        result.alterOperation === "ALTER_COLUMN" ||
        result.alterOperation === "MODIFY_COLUMN" ||
        result.alterOperation === "RENAME_COLUMN"
      ) {
        result.column = extractColumnName(sql);
      }
      if (
        result.alterOperation === "ADD_CONSTRAINT" ||
        result.alterOperation === "DROP_CONSTRAINT"
      ) {
        result.constraintName = extractConstraintName(sql);
      }
      if (
        result.alterOperation === "ADD_INDEX" ||
        result.alterOperation === "DROP_INDEX" ||
        result.alterOperation === "RENAME_INDEX"
      ) {
        result.index = extractAlterIndexName(sql);
      }
      break;

    case "CREATE_INDEX":
    case "DROP_INDEX":
      result.index = extractIndexName(sql);
      // Try to extract table from CREATE INDEX ... ON "table"
      const onTableMatch = sql.match(/ON\s+[""`]?(\w+)[""`]?/i);
      if (onTableMatch) result.table = onTableMatch[1];
      break;

    case "CREATE_ENUM":
    case "ALTER_ENUM":
    case "DROP_ENUM":
      result.enumName = extractEnumName(sql);
      break;

    case "INSERT":
    case "UPDATE":
    case "DELETE":
    case "OTHER":
      result.table = extractTableName(sql);
      break;
  }

  return result;
}

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let stringChar = "";
  let dollarQuoteDelimiter: string | undefined;
  let parenDepth = 0;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const prevChar = i > 0 ? sql[i - 1] : "";

    if (!inString) {
      if (!dollarQuoteDelimiter) {
        const delimiter = matchDollarQuoteDelimiter(sql, i);
        if (delimiter) {
          dollarQuoteDelimiter = delimiter;
          current += delimiter;
          i += delimiter.length - 1;
          continue;
        }
      } else if (sql.startsWith(dollarQuoteDelimiter, i)) {
        current += dollarQuoteDelimiter;
        i += dollarQuoteDelimiter.length - 1;
        dollarQuoteDelimiter = undefined;
        continue;
      }
    }

    // Handle string literals
    if (!dollarQuoteDelimiter && (char === "'" || char === '"') && prevChar !== "\\") {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
    }

    // Track parentheses depth
    if (!inString && !dollarQuoteDelimiter) {
      if (char === "(") parenDepth++;
      if (char === ")") parenDepth--;
    }

    // Statement terminator
    if (char === ";" && !inString && !dollarQuoteDelimiter && parenDepth === 0) {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = "";
    } else {
      current += char;
    }
  }

  // Handle final statement without semicolon
  const finalStmt = current.trim();
  if (finalStmt) statements.push(finalStmt);

  return statements;
}

/**
 * Split multi-operation ALTER TABLE statements into separate single-operation statements.
 * For example:
 *   ALTER TABLE `X` DROP COLUMN `a`, ADD COLUMN `b` INT
 * Becomes:
 *   ALTER TABLE `X` DROP COLUMN `a`
 *   ALTER TABLE `X` ADD COLUMN `b` INT
 */
function splitAlterTableOperations(stmt: string): string[] {
  const normalized = normalizeWhitespace(stmt);

  // Check if this is an ALTER TABLE statement
  if (!normalized.toUpperCase().startsWith("ALTER TABLE")) {
    return [stmt];
  }

  // Extract the table name part: "ALTER TABLE `tableName`"
  const tableMatch = stmt.match(
    new RegExp(
      `^(\\s*ALTER\\s+TABLE\\s+${QUALIFIED_IDENTIFIER})\\s+`,
      "i"
    )
  );
  if (!tableMatch) {
    return [stmt];
  }

  const alterPrefix = tableMatch[1];
  const operationsPart = stmt.slice(tableMatch[0].length);

  // Split operations by comma, but respect parentheses (for things like FOREIGN KEY ... REFERENCES ...)
  const operations: string[] = [];
  let current = "";
  let parenDepth = 0;
  let inString = false;
  let stringChar = "";
  let dollarQuoteDelimiter: string | undefined;

  for (let i = 0; i < operationsPart.length; i++) {
    const char = operationsPart[i];
    const prevChar = i > 0 ? operationsPart[i - 1] : "";

    if (!inString) {
      if (!dollarQuoteDelimiter) {
        const delimiter = matchDollarQuoteDelimiter(operationsPart, i);
        if (delimiter) {
          dollarQuoteDelimiter = delimiter;
          current += delimiter;
          i += delimiter.length - 1;
          continue;
        }
      } else if (operationsPart.startsWith(dollarQuoteDelimiter, i)) {
        current += dollarQuoteDelimiter;
        i += dollarQuoteDelimiter.length - 1;
        dollarQuoteDelimiter = undefined;
        continue;
      }
    }

    // Handle string literals
    if (
      !dollarQuoteDelimiter &&
      (char === "'" || char === '"' || char === "`") &&
      prevChar !== "\\"
    ) {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
    }

    // Track parentheses depth
    if (!inString && !dollarQuoteDelimiter) {
      if (char === "(") parenDepth++;
      if (char === ")") parenDepth--;
    }

    // Split on comma at top level
    if (char === "," && !inString && !dollarQuoteDelimiter && parenDepth === 0) {
      const op = current.trim();
      if (op) operations.push(op);
      current = "";
    } else {
      current += char;
    }
  }

  // Handle final operation
  const finalOp = current.trim();
  if (finalOp) operations.push(finalOp);

  // If only one operation, return original statement
  if (operations.length <= 1) {
    return [stmt];
  }

  // Create separate ALTER TABLE statements for each operation
  return operations.map(op => `${alterPrefix} ${op}`);
}

export function parseSQL(sql: string): ParsedStatement[] {
  // Strip comments first
  const cleanedSql = stripLineComments(stripBlockComments(sql));

  const statements = splitStatements(cleanedSql);

  // Expand multi-operation ALTER TABLE statements
  const expandedStatements: string[] = [];
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed && !trimmed.startsWith("--")) {
      expandedStatements.push(...splitAlterTableOperations(trimmed));
    }
  }

  return expandedStatements
    .filter((s) => {
      const trimmed = s.trim();
      return trimmed && !trimmed.startsWith("--");
    })
    .map((s) => parseStatement(s));
}
