import { describe, expect, test } from "bun:test";
import type { Migration } from "./scanner";
import {
  buildPrecheckedMigrationChoices,
  getMigrationsNewestFirst,
  parseExcludePatterns,
  resolveMigrationByQuery,
  selectLatestMigrations,
  selectMigrationsByNames,
  selectMigrationsFromBoundary,
} from "./selection";

function makeMigration(name: string): Migration {
  return {
    name,
    path: `/tmp/${name}`,
    timestamp: name.split("_")[0] ?? name,
    sql: "",
  };
}

describe("selection helpers", () => {
  test("parses exclude patterns from comma-separated input", () => {
    expect(parseExcludePatterns("prod_01, prod_02, ,release*")).toEqual([
      "prod_01",
      "prod_02",
      "release*",
    ]);
  });

  test("orders migrations newest first for boundary picker", () => {
    const migrations = [
      makeMigration("20240101_a"),
      makeMigration("20240102_b"),
      makeMigration("20240103_c"),
    ];

    expect(getMigrationsNewestFirst(migrations).map((migration) => migration.name)).toEqual([
      "20240103_c",
      "20240102_b",
      "20240101_a",
    ]);
  });

  test("selects boundary migration plus newer migrations", () => {
    const migrations = [
      makeMigration("20240101_a"),
      makeMigration("20240102_b"),
      makeMigration("20240103_c"),
      makeMigration("20240104_d"),
    ];

    const selection = selectMigrationsFromBoundary(migrations, "20240102_b");

    expect(selection.boundary.name).toBe("20240102_b");
    expect(selection.selected.map((migration) => migration.name)).toEqual([
      "20240102_b",
      "20240103_c",
      "20240104_d",
    ]);
  });

  test("builds prechecked choices for quick cherry-pick", () => {
    const migrations = [makeMigration("20240101_a"), makeMigration("20240102_b")];

    expect(buildPrecheckedMigrationChoices(migrations)).toEqual([
      { name: "20240101_a", value: "20240101_a", checked: true },
      { name: "20240102_b", value: "20240102_b", checked: true },
    ]);
  });

  test("supports cherry-picking non-contiguous migrations", () => {
    const migrations = [
      makeMigration("20240102_b"),
      makeMigration("20240103_c"),
      makeMigration("20240104_d"),
    ];

    const selected = selectMigrationsByNames(migrations, [
      "20240102_b",
      "20240104_d",
    ]);

    expect(selected.map((migration) => migration.name)).toEqual([
      "20240102_b",
      "20240104_d",
    ]);
  });

  test("resolves --from by exact match", () => {
    const migrations = [makeMigration("20240101_init"), makeMigration("20240102_add_user")];
    const resolved = resolveMigrationByQuery(migrations, "20240102_add_user");
    expect(resolved.name).toBe("20240102_add_user");
  });

  test("resolves --from by unique fragment", () => {
    const migrations = [makeMigration("20240101_init"), makeMigration("20240102_add_user")];
    const resolved = resolveMigrationByQuery(migrations, "add_user");
    expect(resolved.name).toBe("20240102_add_user");
  });

  test("throws on ambiguous --from fragment with deterministic candidates", () => {
    const migrations = [
      makeMigration("20240101_add_user"),
      makeMigration("20240102_add_user_email"),
      makeMigration("20240103_add_profile"),
    ];

    expect(() => resolveMigrationByQuery(migrations, "add_user")).toThrow(
      'Multiple migrations matched --from "add_user". Be more specific:\n  - 20240101_add_user\n  - 20240102_add_user_email'
    );
  });

  test("throws on missing --from fragment", () => {
    const migrations = [makeMigration("20240101_init"), makeMigration("20240102_add_user")];

    expect(() => resolveMigrationByQuery(migrations, "does_not_exist")).toThrow(
      'No migration matched --from "does_not_exist". Use an exact name or unique fragment.'
    );
  });

  test("legacy latest selection still works", () => {
    const migrations = [
      makeMigration("20240101_prod_01"),
      makeMigration("20240102_prod_02"),
      makeMigration("20240103_dev_01"),
      makeMigration("20240104_dev_02"),
      makeMigration("20240105_dev_03"),
      makeMigration("20240106_dev_04"),
    ];

    const result = selectLatestMigrations(migrations, 3, ["prod"]);

    expect(result.selected.map((migration) => migration.name)).toEqual([
      "20240104_dev_02",
      "20240105_dev_03",
      "20240106_dev_04",
    ]);
    expect(result.hasGaps).toBe(false);
  });
});
