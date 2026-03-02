import type { Migration } from "./scanner";
import { parseSQL, type ParsedStatement } from "./parser";

interface StatementTracker {
  statement: ParsedStatement;
  migrationName: string;
  removed: boolean;
  removalReason?: string;
}

interface ParsedIdentifier {
  raw: string;
  value: string;
  end: number;
}

interface ParsedCreateTable {
  tableName: string;
  tableKey: string;
  createPrefix: string;
  createSuffix: string;
  columns: Map<string, string>;
  columnOrder: string[];
  namedIndexes: Map<string, string>;
  namedConstraints: Map<string, string>;
  unnamedConstraints: string[];
}

interface TableState extends ParsedCreateTable {
  createTrackerIndex: number;
  dropped: boolean;
}

export interface SquashResult {
  sql: string;
  removedStatements: Array<{
    statement: string;
    reason: string;
    migration: string;
  }>;
  keptStatements: Array<{
    statement: string;
    migration: string;
  }>;
}

function normalizeIdentifier(name: string): string {
  return name.replace(/^["`']|["`']$/g, "").toLowerCase();
}

function normalizeSqlForCompare(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readIdentifierToken(input: string, start = 0): ParsedIdentifier | undefined {
  let i = start;
  while (i < input.length && /\s/.test(input[i] ?? "")) i++;
  if (i >= input.length) return undefined;

  const first = input[i] ?? "";

  if (first === '"' || first === "`" || first === "'") {
    let j = i + 1;
    while (j < input.length && (input[j] ?? "") !== first) j++;
    if (j >= input.length) return undefined;

    const raw = input.slice(i, j + 1);
    return {
      raw,
      value: raw.slice(1, -1),
      end: j + 1,
    };
  }

  if (!/[A-Za-z0-9_]/.test(first)) return undefined;

  let j = i;
  while (j < input.length && /[A-Za-z0-9_]/.test(input[j] ?? "")) j++;

  const raw = input.slice(i, j);
  return {
    raw,
    value: raw,
    end: j,
  };
}

function readQualifiedIdentifier(
  input: string,
  start: number
): { raw: string; value: string; end: number } | undefined {
  const first = readIdentifierToken(input, start);
  if (!first) return undefined;

  let i = first.end;
  let raw = first.raw;
  let value = first.value;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i] ?? "")) i++;
    if ((input[i] ?? "") !== ".") break;
    i++;

    const next = readIdentifierToken(input, i);
    if (!next) break;

    raw += `.${next.raw}`;
    value = next.value;
    i = next.end;
  }

  return { raw, value, end: i };
}

function splitTopLevelByComma(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let parenDepth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < input.length; i++) {
    const char = input[i] ?? "";
    const prev = i > 0 ? input[i - 1] ?? "" : "";

    if ((char === "'" || char === '"' || char === "`") && prev !== "\\") {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
    }

    if (!inString) {
      if (char === "(") parenDepth++;
      if (char === ")") parenDepth--;
    }

    if (char === "," && !inString && parenDepth === 0) {
      const part = current.trim();
      if (part) parts.push(part);
      current = "";
      continue;
    }

    current += char;
  }

  const last = current.trim();
  if (last) parts.push(last);

  return parts;
}

function findMatchingParenIndex(input: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = openIndex; i < input.length; i++) {
    const char = input[i] ?? "";
    const prev = i > 0 ? input[i - 1] ?? "" : "";

    if ((char === "'" || char === '"' || char === "`") && prev !== "\\") {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
    }

    if (inString) continue;

    if (char === "(") depth++;
    if (char === ")") depth--;

    if (depth === 0) return i;
  }

  return -1;
}

function isConstraintDefinition(definition: string): boolean {
  const normalized = definition.trim().toUpperCase();
  return (
    normalized.startsWith("CONSTRAINT ") ||
    normalized.startsWith("PRIMARY KEY") ||
    normalized.startsWith("UNIQUE") ||
    normalized.startsWith("FOREIGN KEY") ||
    normalized.startsWith("CHECK") ||
    normalized.startsWith("EXCLUDE")
  );
}

function extractNamedConstraintKey(definition: string): string | undefined {
  if (!/^\s*CONSTRAINT\b/i.test(definition)) return undefined;

  const afterKeyword = definition.replace(/^\s*CONSTRAINT\s+/i, "");
  const nameToken = readIdentifierToken(afterKeyword, 0);
  if (!nameToken) return undefined;

  return normalizeIdentifier(nameToken.value);
}

function extractNamedIndexKey(definition: string): string | undefined {
  const trimmed = definition.trim();
  const indexKeywordMatch = /^(?:UNIQUE\s+)?(?:INDEX|KEY)\b/i.exec(trimmed);
  if (!indexKeywordMatch) return undefined;

  const nameToken = readIdentifierToken(trimmed, indexKeywordMatch[0].length);
  if (!nameToken) return undefined;

  return normalizeIdentifier(nameToken.value);
}

function extractReferencedTableKey(definition: string): string | undefined {
  const referencesMatch = /\bREFERENCES\b/i.exec(definition);
  if (!referencesMatch) return undefined;

  const identifier = readQualifiedIdentifier(
    definition,
    referencesMatch.index + referencesMatch[0].length
  );

  if (!identifier) return undefined;
  return normalizeIdentifier(identifier.value);
}

function removeConstraintsReferencingTransientTables(
  tableState: TableState,
  transientTables: Set<string>
): void {
  if (transientTables.size === 0) return;

  for (const [constraintKey, definition] of tableState.namedConstraints) {
    const referencedTable = extractReferencedTableKey(definition);
    if (referencedTable && transientTables.has(referencedTable)) {
      tableState.namedConstraints.delete(constraintKey);
    }
  }

  tableState.unnamedConstraints = tableState.unnamedConstraints.filter(
    (definition) => {
      const referencedTable = extractReferencedTableKey(definition);
      return !referencedTable || !transientTables.has(referencedTable);
    }
  );
}

function parseCreateTableStatement(sql: string): ParsedCreateTable | undefined {
  const trimmed = sql.trim();
  const createMatch = /^CREATE\s+TABLE\b/i.exec(trimmed);
  if (!createMatch) return undefined;

  let cursor = createMatch[0].length;

  const ifNotExists = /^\s*IF\s+NOT\s+EXISTS\b/i.exec(trimmed.slice(cursor));
  if (ifNotExists) cursor += ifNotExists[0].length;

  const tableIdentifier = readQualifiedIdentifier(trimmed, cursor);
  if (!tableIdentifier) return undefined;
  cursor = tableIdentifier.end;

  while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? "")) cursor++;
  if ((trimmed[cursor] ?? "") !== "(") return undefined;

  const openParen = cursor;
  const closeParen = findMatchingParenIndex(trimmed, openParen);
  if (closeParen === -1) return undefined;

  const createPrefix = trimmed.slice(0, openParen).trim();
  const createSuffix = trimmed.slice(closeParen + 1).trim();
  const body = trimmed.slice(openParen + 1, closeParen);

  const columns = new Map<string, string>();
  const columnOrder: string[] = [];
  const namedIndexes = new Map<string, string>();
  const namedConstraints = new Map<string, string>();
  const unnamedConstraints: string[] = [];

  for (const part of splitTopLevelByComma(body)) {
    const entry = part.trim();
    if (!entry) continue;

    const indexKey = extractNamedIndexKey(entry);
    if (indexKey) {
      namedIndexes.set(indexKey, entry);
      continue;
    }

    if (isConstraintDefinition(entry)) {
      const constraintKey = extractNamedConstraintKey(entry);
      if (constraintKey) {
        namedConstraints.set(constraintKey, entry);
      } else {
        const normalized = normalizeSqlForCompare(entry);
        if (!unnamedConstraints.some((existing) => normalizeSqlForCompare(existing) === normalized)) {
          unnamedConstraints.push(entry);
        }
      }
      continue;
    }

    const columnToken = readIdentifierToken(entry, 0);
    if (!columnToken) {
      const normalized = normalizeSqlForCompare(entry);
      if (!unnamedConstraints.some((existing) => normalizeSqlForCompare(existing) === normalized)) {
        unnamedConstraints.push(entry);
      }
      continue;
    }

    const columnKey = normalizeIdentifier(columnToken.value);
    if (!columns.has(columnKey)) columnOrder.push(columnKey);
    columns.set(columnKey, entry);
  }

  return {
    tableName: tableIdentifier.value,
    tableKey: normalizeIdentifier(tableIdentifier.value),
    createPrefix,
    createSuffix,
    columns,
    columnOrder,
    namedIndexes,
    namedConstraints,
    unnamedConstraints,
  };
}

function renderCreateTable(state: TableState): string {
  const lines: string[] = [];

  for (const key of state.columnOrder) {
    const definition = state.columns.get(key);
    if (definition) lines.push(`  ${definition}`);
  }

  for (const definition of state.namedConstraints.values()) {
    lines.push(`  ${definition}`);
  }

  for (const definition of state.namedIndexes.values()) {
    lines.push(`  ${definition}`);
  }

  for (const definition of state.unnamedConstraints) {
    lines.push(`  ${definition}`);
  }

  const body = lines.join(",\n");
  const suffix = state.createSuffix ? ` ${state.createSuffix}` : "";

  return `${state.createPrefix} (\n${body}\n)${suffix}`;
}

function extractAlterClause(sql: string): string | undefined {
  const trimmed = sql.trim();
  const alterMatch = /^ALTER\s+TABLE\b/i.exec(trimmed);
  if (!alterMatch) return undefined;

  let cursor = alterMatch[0].length;
  const tableIdentifier = readQualifiedIdentifier(trimmed, cursor);
  if (!tableIdentifier) return undefined;
  cursor = tableIdentifier.end;

  const clause = trimmed.slice(cursor).trim();
  return clause || undefined;
}

function parseAddColumnFromClause(
  clause: string
): { columnKey: string; definition: string } | undefined {
  if (!/^ADD\b/i.test(clause)) return undefined;

  let rest = clause.replace(/^ADD\s+/i, "").trim();
  rest = rest.replace(/^COLUMN\s+/i, "").trim();
  rest = rest.replace(/^IF\s+NOT\s+EXISTS\s+/i, "").trim();

  const columnToken = readIdentifierToken(rest, 0);
  if (!columnToken) return undefined;

  return {
    columnKey: normalizeIdentifier(columnToken.value),
    definition: rest,
  };
}

function parseDropColumnKeyFromClause(clause: string): string | undefined {
  if (!/^DROP\b/i.test(clause)) return undefined;

  let rest = clause.replace(/^DROP\s+/i, "").trim();
  rest = rest.replace(/^COLUMN\s+/i, "").trim();
  rest = rest.replace(/^IF\s+EXISTS\s+/i, "").trim();

  const columnToken = readIdentifierToken(rest, 0);
  return columnToken ? normalizeIdentifier(columnToken.value) : undefined;
}

function parseRenameColumnFromClause(
  clause: string
): { fromKey: string; toRaw: string; toKey: string } | undefined {
  let rest = clause.trim();
  if (!/^RENAME\b/i.test(rest)) return undefined;

  rest = rest.replace(/^RENAME\s+/i, "").trim();
  rest = rest.replace(/^COLUMN\s+/i, "").trim();

  const fromToken = readIdentifierToken(rest, 0);
  if (!fromToken) return undefined;

  const afterFrom = rest.slice(fromToken.end).trim();
  if (!/^TO\b/i.test(afterFrom)) return undefined;

  const toToken = readIdentifierToken(afterFrom.replace(/^TO\s+/i, ""), 0);
  if (!toToken) return undefined;

  return {
    fromKey: normalizeIdentifier(fromToken.value),
    toRaw: toToken.raw,
    toKey: normalizeIdentifier(toToken.value),
  };
}

function parseAlterColumnFromClause(
  clause: string
): { columnKey: string; action: string } | undefined {
  if (!/^ALTER\b/i.test(clause)) return undefined;

  let rest = clause.replace(/^ALTER\s+/i, "").trim();
  rest = rest.replace(/^COLUMN\s+/i, "").trim();

  const columnToken = readIdentifierToken(rest, 0);
  if (!columnToken) return undefined;

  const action = rest.slice(columnToken.end).trim();
  if (!action) return undefined;

  return {
    columnKey: normalizeIdentifier(columnToken.value),
    action,
  };
}

function parseModifyColumnFromClause(
  clause: string
): { columnKey: string; definition: string } | undefined {
  if (!/^MODIFY\b/i.test(clause)) return undefined;

  let rest = clause.replace(/^MODIFY\s+/i, "").trim();
  rest = rest.replace(/^COLUMN\s+/i, "").trim();

  const columnToken = readIdentifierToken(rest, 0);
  if (!columnToken) return undefined;

  return {
    columnKey: normalizeIdentifier(columnToken.value),
    definition: rest,
  };
}

function splitColumnDefinition(definition: string):
  | {
      nameRaw: string;
      remainder: string;
    }
  | undefined {
  const token = readIdentifierToken(definition, 0);
  if (!token) return undefined;

  return {
    nameRaw: token.raw,
    remainder: definition.slice(token.end).trim(),
  };
}

function rebuildColumnDefinition(nameRaw: string, remainder: string): string {
  const trimmed = remainder.trim();
  return trimmed ? `${nameRaw} ${trimmed}` : nameRaw;
}

function removeDefaultClause(remainder: string): string {
  return remainder
    .replace(
      /\s+DEFAULT\s+.+?(?=(\s+NOT\s+NULL|\s+NULL|\s+COLLATE|\s+CONSTRAINT|\s+PRIMARY\s+KEY|\s+UNIQUE|\s+CHECK|\s+REFERENCES|$))/i,
      ""
    )
    .trim();
}

function replaceColumnType(remainder: string, newType: string): string {
  const constraintMatch = remainder.match(
    /\s+(DEFAULT|NOT\s+NULL|NULL|COLLATE|CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|REFERENCES|GENERATED)\b/i
  );

  if (!constraintMatch || typeof constraintMatch.index !== "number") {
    return newType.trim();
  }

  const tail = remainder.slice(constraintMatch.index).trim();
  return tail ? `${newType.trim()} ${tail}` : newType.trim();
}

function applyAlterColumnAction(
  definition: string,
  action: string
): string | undefined {
  const parsed = splitColumnDefinition(definition);
  if (!parsed) return undefined;

  const actionTrimmed = action.trim();
  const upperAction = actionTrimmed.toUpperCase();
  let remainder = parsed.remainder;

  if (upperAction.startsWith("SET DEFAULT ")) {
    const defaultExpr = actionTrimmed.slice("SET DEFAULT ".length).trim();
    remainder = removeDefaultClause(remainder);
    remainder = `${remainder} DEFAULT ${defaultExpr}`.trim();
    return rebuildColumnDefinition(parsed.nameRaw, remainder);
  }

  if (upperAction === "DROP DEFAULT") {
    remainder = removeDefaultClause(remainder);
    return rebuildColumnDefinition(parsed.nameRaw, remainder);
  }

  if (upperAction === "SET NOT NULL") {
    remainder = remainder.replace(/\s+NOT\s+NULL\b/i, "").replace(/\s+NULL\b/i, "").trim();
    remainder = `${remainder} NOT NULL`.trim();
    return rebuildColumnDefinition(parsed.nameRaw, remainder);
  }

  if (upperAction === "DROP NOT NULL") {
    remainder = remainder.replace(/\s+NOT\s+NULL\b/i, "").trim();
    return rebuildColumnDefinition(parsed.nameRaw, remainder);
  }

  if (upperAction.startsWith("TYPE ") || upperAction.startsWith("SET DATA TYPE ")) {
    if (/\bUSING\b/i.test(actionTrimmed)) {
      return undefined;
    }

    const newType = upperAction.startsWith("SET DATA TYPE ")
      ? actionTrimmed.slice("SET DATA TYPE ".length)
      : actionTrimmed.slice("TYPE ".length);

    remainder = replaceColumnType(remainder, newType);
    return rebuildColumnDefinition(parsed.nameRaw, remainder);
  }

  return undefined;
}

function replaceLeadingIdentifier(definition: string, newIdentifierRaw: string): string {
  const token = readIdentifierToken(definition, 0);
  if (!token) return definition;

  const rest = definition.slice(token.end).trim();
  return rest ? `${newIdentifierRaw} ${rest}` : newIdentifierRaw;
}

function parseAddConstraintDefinition(
  clause: string
): { definition: string; constraintKey?: string } | undefined {
  if (!/^ADD\b/i.test(clause)) return undefined;

  const definition = clause.replace(/^ADD\s+/i, "").trim();
  if (!definition) return undefined;

  return {
    definition,
    constraintKey: extractNamedConstraintKey(definition),
  };
}

function parseAddIndexDefinition(
  clause: string
): { definition: string; indexKey?: string } | undefined {
  if (!/^ADD\b/i.test(clause)) return undefined;

  const definition = clause.replace(/^ADD\s+/i, "").trim();
  if (!definition) return undefined;

  return {
    definition,
    indexKey: extractNamedIndexKey(definition),
  };
}

function parseDropIndexKeyFromClause(clause: string): string | undefined {
  if (!/^DROP\b/i.test(clause)) return undefined;

  let rest = clause.replace(/^DROP\s+/i, "").trim();
  rest = rest.replace(/^(?:INDEX|KEY)\s+/i, "").trim();
  rest = rest.replace(/^IF\s+EXISTS\s+/i, "").trim();

  const token = readIdentifierToken(rest, 0);
  return token ? normalizeIdentifier(token.value) : undefined;
}

function parseDropConstraint(
  clause: string
): { constraintKey?: string; dropPrimaryKey: boolean } | undefined {
  if (!/^DROP\b/i.test(clause)) return undefined;

  let rest = clause.replace(/^DROP\s+/i, "").trim();

  if (/^CONSTRAINT\b/i.test(rest)) {
    rest = rest.replace(/^CONSTRAINT\s+/i, "").trim();
    const token = readIdentifierToken(rest, 0);
    return {
      constraintKey: token ? normalizeIdentifier(token.value) : undefined,
      dropPrimaryKey: false,
    };
  }

  if (/^FOREIGN\s+KEY\b/i.test(rest)) {
    rest = rest.replace(/^FOREIGN\s+KEY\s+/i, "").trim();
    const token = readIdentifierToken(rest, 0);
    return {
      constraintKey: token ? normalizeIdentifier(token.value) : undefined,
      dropPrimaryKey: false,
    };
  }

  if (/^PRIMARY\s+KEY\b/i.test(rest)) {
    return {
      dropPrimaryKey: true,
    };
  }

  return undefined;
}

function getColumnLifecycleKey(tableKey: string, columnKey: string): string {
  return `${tableKey}.column:${columnKey}`;
}

function getConstraintLifecycleKey(tableKey: string, constraintKey: string): string {
  return `${tableKey}.constraint:${constraintKey}`;
}

function markRemoved(
  tracker: StatementTracker,
  removedStatements: SquashResult["removedStatements"],
  reason: string
): void {
  if (tracker.removed) return;

  tracker.removed = true;
  tracker.removalReason = reason;
  removedStatements.push({
    statement: tracker.statement.raw,
    reason,
    migration: tracker.migrationName,
  });
}

function updateColumnOrder(order: string[], fromKey: string, toKey: string): void {
  const index = order.indexOf(fromKey);
  if (index === -1) return;
  order[index] = toKey;
}

export function squashMigrations(migrations: Migration[]): SquashResult {
  const allTrackers: StatementTracker[] = [];
  const removedStatements: SquashResult["removedStatements"] = [];
  const keptStatements: SquashResult["keptStatements"] = [];

  for (const migration of migrations) {
    const statements = parseSQL(migration.sql);
    for (const statement of statements) {
      allTrackers.push({
        statement,
        migrationName: migration.name,
        removed: false,
      });
    }
  }

  const tableStates = new Map<string, TableState>();
  const pendingAddedColumns = new Map<string, number>();
  const pendingAddedConstraints = new Map<string, number>();
  const pendingModifiedColumns = new Map<string, number>();
  const pendingAlteredColumns = new Map<string, number>();
  const createdIndexes = new Map<string, number>();
  const createdEnums = new Map<string, number>();
  const transientTables = new Set<string>();

  for (let i = 0; i < allTrackers.length; i++) {
    const tracker = allTrackers[i] as StatementTracker;
    const stmt = tracker.statement;

    switch (stmt.type) {
      case "CREATE_TABLE": {
        const parsedCreate = parseCreateTableStatement(stmt.raw);
        if (!parsedCreate) break;

        tableStates.set(parsedCreate.tableKey, {
          ...parsedCreate,
          createTrackerIndex: i,
          dropped: false,
        });
        break;
      }

      case "DROP_TABLE": {
        if (!stmt.table) break;

        const tableKey = normalizeIdentifier(stmt.table);
        const tableState = tableStates.get(tableKey);
        if (!tableState || tableState.dropped) break;

        tableState.dropped = true;
        transientTables.add(tableKey);

        markRemoved(
          allTrackers[tableState.createTrackerIndex] as StatementTracker,
          removedStatements,
          `Table "${tableState.tableName}" was created then dropped`
        );
        markRemoved(
          tracker,
          removedStatements,
          `Table "${tableState.tableName}" was created then dropped`
        );

        break;
      }

      case "ALTER_TABLE": {
        if (!stmt.table || !stmt.alterOperation) break;

        const tableKey = normalizeIdentifier(stmt.table);
        const tableState = tableStates.get(tableKey);

        const clause = extractAlterClause(stmt.raw);
        if (!clause) break;

        if (!tableState || tableState.dropped) {
          switch (stmt.alterOperation) {
            case "ADD_COLUMN": {
              const parsed = parseAddColumnFromClause(clause);
              if (!parsed) break;

              const lifecycleKey = getColumnLifecycleKey(tableKey, parsed.columnKey);
              pendingAddedColumns.set(lifecycleKey, i);
              break;
            }

            case "DROP_COLUMN": {
              const dropKey = parseDropColumnKeyFromClause(clause);
              if (!dropKey) break;

              const lifecycleKey = getColumnLifecycleKey(tableKey, dropKey);
              const addTrackerIndex = pendingAddedColumns.get(lifecycleKey);
              if (typeof addTrackerIndex !== "number") break;

              const reason = `Column "${stmt.table}.${dropKey}" was added then dropped`;
              markRemoved(allTrackers[addTrackerIndex] as StatementTracker, removedStatements, reason);
              markRemoved(tracker, removedStatements, reason);
              pendingAddedColumns.delete(lifecycleKey);

              const modifyTrackerIndex = pendingModifiedColumns.get(lifecycleKey);
              if (typeof modifyTrackerIndex === "number") {
                markRemoved(allTrackers[modifyTrackerIndex] as StatementTracker, removedStatements, reason);
                pendingModifiedColumns.delete(lifecycleKey);
              }

              const alterTrackerIndex = pendingAlteredColumns.get(lifecycleKey);
              if (typeof alterTrackerIndex === "number") {
                markRemoved(allTrackers[alterTrackerIndex] as StatementTracker, removedStatements, reason);
                pendingAlteredColumns.delete(lifecycleKey);
              }
              break;
            }

            case "ADD_CONSTRAINT": {
              const parsedConstraint = parseAddConstraintDefinition(clause);
              if (!parsedConstraint?.constraintKey) break;

              const lifecycleKey = getConstraintLifecycleKey(
                tableKey,
                parsedConstraint.constraintKey
              );
              pendingAddedConstraints.set(lifecycleKey, i);
              break;
            }

            case "DROP_CONSTRAINT": {
              const parsedDrop = parseDropConstraint(clause);
              if (!parsedDrop?.constraintKey) break;

              const lifecycleKey = getConstraintLifecycleKey(
                tableKey,
                parsedDrop.constraintKey
              );
              const addTrackerIndex = pendingAddedConstraints.get(lifecycleKey);
              if (typeof addTrackerIndex !== "number") break;

              markRemoved(
                allTrackers[addTrackerIndex] as StatementTracker,
                removedStatements,
                `Constraint "${parsedDrop.constraintKey}" was added then dropped`
              );
              markRemoved(
                tracker,
                removedStatements,
                `Constraint "${parsedDrop.constraintKey}" was added then dropped`
              );
              pendingAddedConstraints.delete(lifecycleKey);
              break;
            }

            case "MODIFY_COLUMN": {
              const parsed = parseModifyColumnFromClause(clause);
              if (!parsed) break;

              const lifecycleKey = getColumnLifecycleKey(tableKey, parsed.columnKey);
              const prevTrackerIndex = pendingModifiedColumns.get(lifecycleKey);
              if (typeof prevTrackerIndex === "number") {
                markRemoved(
                  allTrackers[prevTrackerIndex] as StatementTracker,
                  removedStatements,
                  `Column "${stmt.table}.${parsed.columnKey}" MODIFY superseded by a later MODIFY`
                );
              }
              pendingModifiedColumns.set(lifecycleKey, i);
              break;
            }

            case "ALTER_COLUMN": {
              const parsed = parseAlterColumnFromClause(clause);
              if (!parsed) break;

              const lifecycleKey = getColumnLifecycleKey(tableKey, parsed.columnKey);
              const prevTrackerIndex = pendingAlteredColumns.get(lifecycleKey);
              if (typeof prevTrackerIndex === "number") {
                markRemoved(
                  allTrackers[prevTrackerIndex] as StatementTracker,
                  removedStatements,
                  `Column "${stmt.table}.${parsed.columnKey}" ALTER superseded by a later ALTER`
                );
              }
              pendingAlteredColumns.set(lifecycleKey, i);
              break;
            }

            case "ADD_INDEX": {
              if (!stmt.index) break;
              createdIndexes.set(normalizeIdentifier(stmt.index), i);
              break;
            }

            case "DROP_INDEX": {
              if (!stmt.index) break;

              const indexKey = normalizeIdentifier(stmt.index);
              const createIndexTrackerIndex = createdIndexes.get(indexKey);
              if (typeof createIndexTrackerIndex !== "number") break;

              markRemoved(
                allTrackers[createIndexTrackerIndex] as StatementTracker,
                removedStatements,
                `Index "${stmt.index}" was created then dropped`
              );
              markRemoved(
                tracker,
                removedStatements,
                `Index "${stmt.index}" was created then dropped`
              );
              createdIndexes.delete(indexKey);
              break;
            }
          }

          break;
        }

        switch (stmt.alterOperation) {
          case "ADD_COLUMN": {
            const parsed = parseAddColumnFromClause(clause);
            if (!parsed) break;

            if (!tableState.columns.has(parsed.columnKey)) {
              tableState.columnOrder.push(parsed.columnKey);
            }
            tableState.columns.set(parsed.columnKey, parsed.definition);

            markRemoved(
              tracker,
              removedStatements,
              `Folded column changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }

          case "DROP_COLUMN": {
            const dropKey = parseDropColumnKeyFromClause(clause);
            if (!dropKey) break;
            if (!tableState.columns.has(dropKey)) break;

            tableState.columns.delete(dropKey);
            tableState.columnOrder = tableState.columnOrder.filter((key) => key !== dropKey);

            markRemoved(
              tracker,
              removedStatements,
              `Folded column changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }

          case "RENAME_COLUMN": {
            const parsedRename = parseRenameColumnFromClause(clause);
            if (!parsedRename) break;

            const definition = tableState.columns.get(parsedRename.fromKey);
            if (!definition) break;

            tableState.columns.delete(parsedRename.fromKey);
            tableState.columns.set(
              parsedRename.toKey,
              replaceLeadingIdentifier(definition, parsedRename.toRaw)
            );
            updateColumnOrder(tableState.columnOrder, parsedRename.fromKey, parsedRename.toKey);

            markRemoved(
              tracker,
              removedStatements,
              `Folded column changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }

          case "ALTER_COLUMN": {
            const parsedAlter = parseAlterColumnFromClause(clause);
            if (!parsedAlter) break;

            const existing = tableState.columns.get(parsedAlter.columnKey);
            if (!existing) break;

            const updated = applyAlterColumnAction(existing, parsedAlter.action);
            if (!updated) break;

            tableState.columns.set(parsedAlter.columnKey, updated);

            markRemoved(
              tracker,
              removedStatements,
              `Folded column changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }

          case "MODIFY_COLUMN": {
            const parsedModify = parseModifyColumnFromClause(clause);
            if (!parsedModify) break;
            if (!tableState.columns.has(parsedModify.columnKey)) break;

            tableState.columns.set(parsedModify.columnKey, parsedModify.definition);

            markRemoved(
              tracker,
              removedStatements,
              `Folded column changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }

          case "ADD_CONSTRAINT": {
            const parsedConstraint = parseAddConstraintDefinition(clause);
            if (!parsedConstraint) break;

            if (parsedConstraint.constraintKey) {
              tableState.namedConstraints.set(
                parsedConstraint.constraintKey,
                parsedConstraint.definition
              );
            } else {
              const normalized = normalizeSqlForCompare(parsedConstraint.definition);
              if (
                !tableState.unnamedConstraints.some(
                  (definition) => normalizeSqlForCompare(definition) === normalized
                )
              ) {
                tableState.unnamedConstraints.push(parsedConstraint.definition);
              }
            }

            markRemoved(
              tracker,
              removedStatements,
              `Folded constraint changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }

          case "DROP_CONSTRAINT": {
            const parsedDrop = parseDropConstraint(clause);
            if (!parsedDrop) break;

            let removedAny = false;
            if (parsedDrop.constraintKey) {
              removedAny = tableState.namedConstraints.delete(parsedDrop.constraintKey);
            }

            if (!removedAny && parsedDrop.dropPrimaryKey) {
              const before = tableState.unnamedConstraints.length;
              tableState.unnamedConstraints = tableState.unnamedConstraints.filter(
                (definition) => !/^\s*PRIMARY\s+KEY\b/i.test(definition)
              );
              removedAny = before !== tableState.unnamedConstraints.length;
            }

            if (!removedAny) break;

            markRemoved(
              tracker,
              removedStatements,
              `Folded constraint changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }

          case "ADD_INDEX": {
            const parsedIndex = parseAddIndexDefinition(clause);
            if (!parsedIndex?.indexKey) break;

            tableState.namedIndexes.set(parsedIndex.indexKey, parsedIndex.definition);

            markRemoved(
              tracker,
              removedStatements,
              `Folded index changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }

          case "DROP_INDEX": {
            const indexKey = stmt.index
              ? normalizeIdentifier(stmt.index)
              : parseDropIndexKeyFromClause(clause);
            if (!indexKey) break;

            const createIndexTrackerIndex = createdIndexes.get(indexKey);
            if (typeof createIndexTrackerIndex === "number") {
              markRemoved(
                allTrackers[createIndexTrackerIndex] as StatementTracker,
                removedStatements,
                `Index "${stmt.index ?? indexKey}" was created then dropped`
              );
              createdIndexes.delete(indexKey);
            } else {
              tableState.namedIndexes.delete(indexKey);
            }

            markRemoved(
              tracker,
              removedStatements,
              `Folded index changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }
        }

        break;
      }

      case "CREATE_INDEX": {
        if (!stmt.index) break;
        createdIndexes.set(normalizeIdentifier(stmt.index), i);
        break;
      }

      case "DROP_INDEX": {
        if (!stmt.index) break;

        const indexKey = normalizeIdentifier(stmt.index);
        const createIndexTrackerIndex = createdIndexes.get(indexKey);
        if (typeof createIndexTrackerIndex === "number") {
          markRemoved(
            allTrackers[createIndexTrackerIndex] as StatementTracker,
            removedStatements,
            `Index "${stmt.index}" was created then dropped`
          );
          markRemoved(
            tracker,
            removedStatements,
            `Index "${stmt.index}" was created then dropped`
          );
          createdIndexes.delete(indexKey);
          break;
        }

        if (stmt.table) {
          const tableKey = normalizeIdentifier(stmt.table);
          const tableState = tableStates.get(tableKey);
          if (tableState && !tableState.dropped) {
            tableState.namedIndexes.delete(indexKey);
            markRemoved(
              tracker,
              removedStatements,
              `Folded index changes into CREATE TABLE "${tableState.tableName}"`
            );
          }
        }
        break;
      }

      case "CREATE_ENUM": {
        if (!stmt.enumName) break;
        createdEnums.set(normalizeIdentifier(stmt.enumName), i);
        break;
      }

      case "DROP_ENUM": {
        if (!stmt.enumName) break;

        const enumKey = normalizeIdentifier(stmt.enumName);
        const createEnumTrackerIndex = createdEnums.get(enumKey);
        if (typeof createEnumTrackerIndex !== "number") break;

        markRemoved(
          allTrackers[createEnumTrackerIndex] as StatementTracker,
          removedStatements,
          `Enum "${stmt.enumName}" was created then dropped`
        );
        markRemoved(
          tracker,
          removedStatements,
          `Enum "${stmt.enumName}" was created then dropped`
        );

        createdEnums.delete(enumKey);
        break;
      }
    }
  }

  if (transientTables.size > 0) {
    for (const tracker of allTrackers) {
      if (tracker.removed) continue;

      const stmt = tracker.statement;
      const statementTable = stmt.table ? normalizeIdentifier(stmt.table) : undefined;

      if (statementTable && transientTables.has(statementTable)) {
        markRemoved(
          tracker,
          removedStatements,
          `References transient table "${stmt.table}" which was created then dropped`
        );
        continue;
      }

      if (stmt.type === "CREATE_TABLE") {
        continue;
      }

      for (const transientTable of transientTables) {
        const pattern = new RegExp(
          `REFERENCES\\s+[\"'\\x60]?${escapeRegExp(transientTable)}[\"'\\x60]?\\s*\\(`,
          "i"
        );

        if (pattern.test(stmt.raw)) {
          markRemoved(
            tracker,
            removedStatements,
            `References transient table "${transientTable}" in foreign key`
          );
          break;
        }
      }
    }
  }

  for (const tableState of tableStates.values()) {
    if (tableState.dropped) continue;

    removeConstraintsReferencingTransientTables(tableState, transientTables);

    const createTracker = allTrackers[tableState.createTrackerIndex];
    if (!createTracker || createTracker.removed) continue;

    createTracker.statement = {
      ...createTracker.statement,
      raw: renderCreateTable(tableState),
    };
  }

  const finalStatements: string[] = [];
  for (const tracker of allTrackers) {
    if (tracker.removed) continue;

    finalStatements.push(tracker.statement.raw);
    keptStatements.push({
      statement: tracker.statement.raw,
      migration: tracker.migrationName,
    });
  }

  const sql =
    finalStatements.join(";\n\n") + (finalStatements.length > 0 ? ";" : "");

  return {
    sql,
    removedStatements,
    keptStatements,
  };
}
