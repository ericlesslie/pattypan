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

interface ColumnRef {
  raw: string;
  key: string;
}

interface IndexEntry {
  prefix: string;
  name: ColumnRef;
  columns: ColumnRef[];
}

interface ForeignKeyEntry {
  type: "FOREIGN_KEY";
  name?: ColumnRef;
  columns: ColumnRef[];
  referencedTable: ColumnRef;
  referencedColumns: ColumnRef[];
  onDelete?: string;
  onUpdate?: string;
}

interface PrimaryKeyEntry {
  type: "PRIMARY_KEY";
  name?: ColumnRef;
  columns: ColumnRef[];
}

interface UniqueConstraintEntry {
  type: "UNIQUE";
  name?: ColumnRef;
  columns: ColumnRef[];
}

interface CheckConstraintEntry {
  type: "CHECK";
  name?: ColumnRef;
  raw: string;
}

interface OtherConstraintEntry {
  type: "OTHER";
  name?: ColumnRef;
  raw: string;
}

type ConstraintEntry =
  | ForeignKeyEntry
  | PrimaryKeyEntry
  | UniqueConstraintEntry
  | CheckConstraintEntry
  | OtherConstraintEntry;

interface ParsedCreateTable {
  tableName: string;
  tableKey: string;
  createPrefix: string;
  createSuffix: string;
  columns: Map<string, string>;
  columnOrder: string[];
  namedIndexes: Map<string, IndexEntry>;
  namedConstraints: Map<string, ConstraintEntry>;
  unnamedConstraints: ConstraintEntry[];
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

// ---------------------------------------------------------------------------
// Structured index / constraint parsing
// ---------------------------------------------------------------------------

function parseColumnRefList(colList: string): ColumnRef[] {
  const refs: ColumnRef[] = [];
  for (const part of splitTopLevelByComma(colList)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const token = readIdentifierToken(trimmed, 0);
    if (!token) continue;
    refs.push({ raw: token.raw, key: normalizeIdentifier(token.value) });
  }
  return refs;
}

function parseIndexEntry(definition: string): IndexEntry | undefined {
  const trimmed = definition.trim();
  const prefixMatch = /^((?:UNIQUE\s+)?(?:INDEX|KEY))\b/i.exec(trimmed);
  if (!prefixMatch) return undefined;

  const prefix = prefixMatch[1].replace(/\s+/g, " ").trim();
  let cursor = prefixMatch[0].length;

  while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? "")) cursor++;

  const nameToken = readIdentifierToken(trimmed, cursor);
  if (!nameToken) return undefined;
  cursor = nameToken.end;

  while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? "")) cursor++;

  if ((trimmed[cursor] ?? "") !== "(") return undefined;

  const closeParen = findMatchingParenIndex(trimmed, cursor);
  if (closeParen === -1) return undefined;

  const columns = parseColumnRefList(trimmed.slice(cursor + 1, closeParen));

  return {
    prefix,
    name: { raw: nameToken.raw, key: normalizeIdentifier(nameToken.value) },
    columns,
  };
}

function parseForeignKeyConstraint(rest: string, name?: ColumnRef): ForeignKeyEntry | undefined {
  const fkMatch = /^FOREIGN\s+KEY\s*/i.exec(rest);
  if (!fkMatch) return undefined;
  let cursor = fkMatch[0].length;

  if ((rest[cursor] ?? "") !== "(") return undefined;
  const colsClose = findMatchingParenIndex(rest, cursor);
  if (colsClose === -1) return undefined;
  const columns = parseColumnRefList(rest.slice(cursor + 1, colsClose));
  cursor = colsClose + 1;

  while (cursor < rest.length && /\s/.test(rest[cursor] ?? "")) cursor++;

  const referencesMatch = /^REFERENCES\s*/i.exec(rest.slice(cursor));
  if (!referencesMatch) return undefined;
  cursor += referencesMatch[0].length;

  const refTable = readQualifiedIdentifier(rest, cursor);
  if (!refTable) return undefined;
  cursor = refTable.end;

  while (cursor < rest.length && /\s/.test(rest[cursor] ?? "")) cursor++;

  let referencedColumns: ColumnRef[] = [];
  if ((rest[cursor] ?? "") === "(") {
    const refColsClose = findMatchingParenIndex(rest, cursor);
    if (refColsClose !== -1) {
      referencedColumns = parseColumnRefList(rest.slice(cursor + 1, refColsClose));
      cursor = refColsClose + 1;
    }
  }

  const remaining = rest.slice(cursor);
  const onDeleteMatch =
    /\bON\s+DELETE\s+(SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION|RESTRICT|CASCADE)\b/i.exec(remaining);
  const onUpdateMatch =
    /\bON\s+UPDATE\s+(SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION|RESTRICT|CASCADE)\b/i.exec(remaining);

  return {
    type: "FOREIGN_KEY",
    name,
    columns,
    referencedTable: { raw: refTable.raw, key: normalizeIdentifier(refTable.value) },
    referencedColumns,
    onDelete: onDeleteMatch?.[1],
    onUpdate: onUpdateMatch?.[1],
  };
}

function parsePrimaryKeyConstraint(rest: string, name?: ColumnRef): PrimaryKeyEntry | undefined {
  const match = /^PRIMARY\s+KEY\s*/i.exec(rest);
  if (!match) return undefined;
  let cursor = match[0].length;

  if ((rest[cursor] ?? "") !== "(") return undefined;
  const close = findMatchingParenIndex(rest, cursor);
  if (close === -1) return undefined;
  const columns = parseColumnRefList(rest.slice(cursor + 1, close));

  return { type: "PRIMARY_KEY", name, columns };
}

function parseUniqueConstraint(rest: string, name?: ColumnRef): UniqueConstraintEntry | undefined {
  const match = /^UNIQUE\b/i.exec(rest);
  if (!match) return undefined;
  let cursor = match[0].length;

  // Skip optional INDEX/KEY keyword
  const indexKeyword = /^\s*(?:INDEX|KEY)\b/i.exec(rest.slice(cursor));
  if (indexKeyword) cursor += indexKeyword[0].length;

  while (cursor < rest.length && /\s/.test(rest[cursor] ?? "")) cursor++;

  // Skip optional index name before the column list
  if ((rest[cursor] ?? "") !== "(") {
    const optName = readIdentifierToken(rest, cursor);
    if (optName) cursor = optName.end;
    while (cursor < rest.length && /\s/.test(rest[cursor] ?? "")) cursor++;
  }

  if ((rest[cursor] ?? "") !== "(") return undefined;
  const close = findMatchingParenIndex(rest, cursor);
  if (close === -1) return undefined;
  const columns = parseColumnRefList(rest.slice(cursor + 1, close));

  return { type: "UNIQUE", name, columns };
}

function parseConstraintEntry(definition: string): ConstraintEntry | undefined {
  let rest = definition.trim();
  let name: ColumnRef | undefined;

  if (/^CONSTRAINT\b/i.test(rest)) {
    rest = rest.replace(/^CONSTRAINT\s+/i, "").trim();
    const nameToken = readIdentifierToken(rest, 0);
    if (nameToken) {
      name = { raw: nameToken.raw, key: normalizeIdentifier(nameToken.value) };
      rest = rest.slice(nameToken.end).trim();
    }
  }

  if (/^FOREIGN\s+KEY\b/i.test(rest)) {
    return parseForeignKeyConstraint(rest, name);
  }
  if (/^PRIMARY\s+KEY\b/i.test(rest)) {
    return parsePrimaryKeyConstraint(rest, name);
  }
  if (/^UNIQUE\b/i.test(rest)) {
    return parseUniqueConstraint(rest, name);
  }
  if (/^CHECK\b/i.test(rest)) {
    return { type: "CHECK", name, raw: definition };
  }

  return { type: "OTHER", name, raw: definition };
}

// ---------------------------------------------------------------------------
// Structured index / constraint rendering
// ---------------------------------------------------------------------------

function renderIndexEntry(entry: IndexEntry): string {
  const cols = entry.columns.map((c) => c.raw).join(", ");
  return `${entry.prefix} ${entry.name.raw} (${cols})`;
}

function renderConstraintEntry(entry: ConstraintEntry): string {
  const prefix = entry.name ? `CONSTRAINT ${entry.name.raw} ` : "";
  switch (entry.type) {
    case "FOREIGN_KEY": {
      const cols = entry.columns.map((c) => c.raw).join(", ");
      const refCols = entry.referencedColumns.map((c) => c.raw).join(", ");
      let result = `${prefix}FOREIGN KEY (${cols}) REFERENCES ${entry.referencedTable.raw} (${refCols})`;
      if (entry.onDelete) result += ` ON DELETE ${entry.onDelete}`;
      if (entry.onUpdate) result += ` ON UPDATE ${entry.onUpdate}`;
      return result;
    }
    case "PRIMARY_KEY": {
      const cols = entry.columns.map((c) => c.raw).join(", ");
      return `${prefix}PRIMARY KEY (${cols})`;
    }
    case "UNIQUE": {
      const cols = entry.columns.map((c) => c.raw).join(", ");
      return `${prefix}UNIQUE (${cols})`;
    }
    case "CHECK":
    case "OTHER":
      return entry.raw;
  }
}

// ---------------------------------------------------------------------------
// Column operation helpers for DROP_COLUMN / RENAME_COLUMN
// ---------------------------------------------------------------------------

function removeColumnFromIndex(entry: IndexEntry, colKey: string): IndexEntry | null {
  const filtered = entry.columns.filter((c) => c.key !== colKey);
  if (filtered.length === 0) return null;
  return { ...entry, columns: filtered };
}

function removeColumnFromConstraint(
  entry: ConstraintEntry,
  colKey: string
): ConstraintEntry | null {
  switch (entry.type) {
    case "FOREIGN_KEY": {
      const filtered = entry.columns.filter((c) => c.key !== colKey);
      if (filtered.length === 0) return null;
      return { ...entry, columns: filtered };
    }
    case "PRIMARY_KEY":
    case "UNIQUE": {
      const filtered = entry.columns.filter((c) => c.key !== colKey);
      if (filtered.length === 0) return null;
      return { ...entry, columns: filtered };
    }
    case "CHECK":
    case "OTHER":
      return entry;
  }
}

function renameColumnInIndex(entry: IndexEntry, oldKey: string, newRef: ColumnRef): IndexEntry {
  return {
    ...entry,
    columns: entry.columns.map((c) => (c.key === oldKey ? newRef : c)),
  };
}

function renameColumnInConstraint(
  entry: ConstraintEntry,
  oldKey: string,
  newRef: ColumnRef
): ConstraintEntry {
  switch (entry.type) {
    case "FOREIGN_KEY":
      return {
        ...entry,
        columns: entry.columns.map((c) => (c.key === oldKey ? newRef : c)),
        referencedColumns: entry.referencedColumns.map((c) => (c.key === oldKey ? newRef : c)),
      };
    case "PRIMARY_KEY":
    case "UNIQUE":
      return {
        ...entry,
        columns: entry.columns.map((c) => (c.key === oldKey ? newRef : c)),
      };
    case "CHECK":
    case "OTHER":
      return entry;
  }
}

// ---------------------------------------------------------------------------
// Transient table FK cleanup
// ---------------------------------------------------------------------------

function removeConstraintsReferencingTransientTables(
  tableState: TableState,
  transientTables: Set<string>
): void {
  if (transientTables.size === 0) return;

  for (const [constraintKey, entry] of tableState.namedConstraints) {
    if (entry.type === "FOREIGN_KEY" && transientTables.has(entry.referencedTable.key)) {
      tableState.namedConstraints.delete(constraintKey);
    }
  }

  tableState.unnamedConstraints = tableState.unnamedConstraints.filter(
    (entry) =>
      entry.type !== "FOREIGN_KEY" || !transientTables.has(entry.referencedTable.key)
  );
}

// ---------------------------------------------------------------------------
// CREATE TABLE parsing / rendering
// ---------------------------------------------------------------------------

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
  const namedIndexes = new Map<string, IndexEntry>();
  const namedConstraints = new Map<string, ConstraintEntry>();
  const unnamedConstraints: ConstraintEntry[] = [];

  for (const part of splitTopLevelByComma(body)) {
    const entry = part.trim();
    if (!entry) continue;

    const indexEntry = parseIndexEntry(entry);
    if (indexEntry) {
      namedIndexes.set(indexEntry.name.key, indexEntry);
      continue;
    }

    if (isConstraintDefinition(entry)) {
      const constraintEntry = parseConstraintEntry(entry);
      if (constraintEntry) {
        if (constraintEntry.name) {
          namedConstraints.set(constraintEntry.name.key, constraintEntry);
        } else {
          unnamedConstraints.push(constraintEntry);
        }
      }
      continue;
    }

    const columnToken = readIdentifierToken(entry, 0);
    if (!columnToken) {
      unnamedConstraints.push({ type: "OTHER", raw: entry });
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

  for (const entry of state.namedConstraints.values()) {
    lines.push(`  ${renderConstraintEntry(entry)}`);
  }

  for (const entry of state.namedIndexes.values()) {
    lines.push(`  ${renderIndexEntry(entry)}`);
  }

  for (const entry of state.unnamedConstraints) {
    lines.push(`  ${renderConstraintEntry(entry)}`);
  }

  const body = lines.join(",\n");
  const suffix = state.createSuffix ? ` ${state.createSuffix}` : "";

  return `${state.createPrefix} (\n${body}\n)${suffix}`;
}

// ---------------------------------------------------------------------------
// ALTER TABLE clause parsers
// ---------------------------------------------------------------------------

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
              const definition = clause.replace(/^ADD\s+/i, "").trim();
              const entry = parseConstraintEntry(definition);
              if (!entry?.name) break;

              const lifecycleKey = getConstraintLifecycleKey(tableKey, entry.name.key);
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

            // Purge indexes / constraints whose column list becomes empty
            for (const [key, entry] of tableState.namedIndexes) {
              const updated = removeColumnFromIndex(entry, dropKey);
              if (updated === null) tableState.namedIndexes.delete(key);
              else tableState.namedIndexes.set(key, updated);
            }
            for (const [key, entry] of tableState.namedConstraints) {
              const updated = removeColumnFromConstraint(entry, dropKey);
              if (updated === null) tableState.namedConstraints.delete(key);
              else tableState.namedConstraints.set(key, updated);
            }
            tableState.unnamedConstraints = tableState.unnamedConstraints
              .map((e) => removeColumnFromConstraint(e, dropKey))
              .filter((e): e is ConstraintEntry => e !== null);

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

            // Propagate rename into indexes and constraints
            const newRef: ColumnRef = { raw: parsedRename.toRaw, key: parsedRename.toKey };
            for (const [key, entry] of tableState.namedIndexes) {
              tableState.namedIndexes.set(
                key,
                renameColumnInIndex(entry, parsedRename.fromKey, newRef)
              );
            }
            for (const [key, entry] of tableState.namedConstraints) {
              tableState.namedConstraints.set(
                key,
                renameColumnInConstraint(entry, parsedRename.fromKey, newRef)
              );
            }
            tableState.unnamedConstraints = tableState.unnamedConstraints.map((e) =>
              renameColumnInConstraint(e, parsedRename.fromKey, newRef)
            );

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
            const definition = clause.replace(/^ADD\s+/i, "").trim();
            const entry = parseConstraintEntry(definition);
            if (!entry) break;

            if (entry.name) {
              tableState.namedConstraints.set(entry.name.key, entry);
            } else {
              tableState.unnamedConstraints.push(entry);
            }

            markRemoved(
              tracker,
              removedStatements,
              `Folded constraint into CREATE TABLE "${tableState.tableName}"`
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
                (entry) => entry.type !== "PRIMARY_KEY"
              );
              removedAny = before !== tableState.unnamedConstraints.length;
            }

            if (!removedAny) {
              // Table is squash-owned; constraint was never created in squash range → no-op
              markRemoved(
                tracker,
                removedStatements,
                `Constraint not present in squash range (no-op)`
              );
              break;
            }

            markRemoved(
              tracker,
              removedStatements,
              `Folded constraint changes into CREATE TABLE "${tableState.tableName}"`
            );
            break;
          }

          case "ADD_INDEX": {
            const definition = clause.replace(/^ADD\s+/i, "").trim();
            const entry = parseIndexEntry(definition);
            if (!entry) break;

            tableState.namedIndexes.set(entry.name.key, entry);

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
