import { describe, expect, test } from "bun:test";
import { assertOutputDirNotInSelectedMigrations } from "./output";
import type { Migration } from "./scanner";

function migration(name: string, path: string): Migration {
  return {
    name,
    path,
    timestamp: name.split("_")[0] ?? name,
    sql: "",
  };
}

describe("output guards", () => {
  test("throws when output directory collides with selected migration path", () => {
    const selected = [
      migration("20240101000000_init", "/tmp/prisma/migrations/20240101000000_init"),
    ];

    expect(() =>
      assertOutputDirNotInSelectedMigrations(
        selected,
        "/tmp/prisma/migrations/20240101000000_init"
      )
    ).toThrow(
      'Output migration directory conflicts with selected migration "20240101000000_init". Choose a different output name.'
    );
  });

  test("does not throw when output directory is unique", () => {
    const selected = [
      migration("20240101000000_init", "/tmp/prisma/migrations/20240101000000_init"),
    ];

    expect(() =>
      assertOutputDirNotInSelectedMigrations(
        selected,
        "/tmp/prisma/migrations/20240102000000_pattypan"
      )
    ).not.toThrow();
  });
});
