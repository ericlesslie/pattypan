import { describe, expect, test } from "bun:test";
import { buildPrismaMigrationSyncScript } from "./prisma-sync";

describe("buildPrismaMigrationSyncScript", () => {
  test("embeds the squashed migration metadata and Prisma disconnect wrapper", () => {
    const script = buildPrismaMigrationSyncScript({
      outputMigrationName: "20240109999999_squashed",
      outputSql: "CREATE TABLE `User` (`id` INT NOT NULL, PRIMARY KEY (`id`));\n",
      replacedMigrations: [
        { name: "20240101000000_init" },
        { name: "20240102000000_add_role" },
      ],
    });

    expect(script).toContain('import { PrismaClient } from "@prisma/client";');
    expect(script).toContain("const squashedMigrationName = \"20240109999999_squashed\";");
    expect(script).toContain("20240101000000_init");
    expect(script).toContain("20240102000000_add_role");
    expect(script).toContain("main()");
    expect(script).toContain("console.log('Finished');");
    expect(script).toContain("void prisma.$disconnect();");
    expect(script).toContain("DELETE FROM ");
    expect(script).toContain("INSERT INTO ");
  });
});
