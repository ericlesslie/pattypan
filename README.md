<div align="center">
  <img src="./icon.svg" alt="Pattypan" width="96" />
  <h1>Pattypan</h1>
  <p>Squash Prisma migrations into one compact baseline migration.</p>
</div>



The squasher folds compatible `ALTER TABLE` operations into the originating
`CREATE TABLE` so output is a compact schema baseline (instead of appending
retained statements).

## Requirements

- [Node.js](https://nodejs.org) 18.18+ or [Bun](https://bun.com)
- A Prisma project with a migrations directory such as `prisma/migrations`
- If you plan to run the generated Prisma metadata sync helper: `prisma` and `@prisma/client`

## Install

For local development:

```bash
bun install
```

Run directly from the repo:

```bash
bun run index.ts
```

If you want a convenient local CLI during development, link it once from this repo:

```bash
bun link
```

Then you can run it as:

```bash
pattypan prisma/migrations
```

After publishing to npm, install or run it with either runtime:

```bash
npx pattypan
```

```bash
bunx pattypan
```

Primary workflow (boundary-based quick pick):

```bash
bun run index.ts
```

In quick mode, you:

1. Pick one boundary migration from a newest-first list (page size 5).
2. Tool auto-selects that migration plus all newer migrations.
3. Tool opens a prechecked cherry-pick list where you can uncheck any items.

Non-interactive boundary workflow:

```bash
bun run index.ts --from 20240115094500_add_orders
```

You can also pass a unique fragment:

```bash
bun run index.ts --from add_orders
```

Optional additive exclusions (applied after boundary selection):

```bash
bun run index.ts --from add_orders --exclude production_20240101,production_20240115
```

Useful options:

- `--from <migration>`: boundary migration name or unique fragment
- `--exclude <patterns>`: comma-separated migration filters to skip
  - supports `*` wildcard, otherwise substring matching
- `--yes, -y`: skip confirmation prompt
- `--remove-dml`: strip `INSERT`, `UPDATE`, and `DELETE` statements from the squashed output
- `--name <migration_name>`: set output migration directory name
- `--latest, -n <count>`: legacy selection mode for latest N migrations
- `--allow-gaps`: legacy latest mode only

If selected migrations contain data-migration statements (`INSERT`, `UPDATE`, or `DELETE`),
Pattypan keeps them by default. Interactive runs offer a prompt to remove them, and
non-interactive runs can opt in with `--remove-dml`.

## Output

Each squash writes:

- a new squashed `migration.sql` inside the selected output migration directory
- a companion `syncPrismaMigrations.ts` file in the migrations directory root

The generated `syncPrismaMigrations.ts` helper is intended for existing databases where
you need to replace the selected `_prisma_migrations` rows with the new squashed
migration entry.

## Publishing

Pattypan now ships as a built Node-compatible CLI from `dist/cli.js`.

Before publishing:

```bash
bun install
bun run build
npm pack --dry-run
```

Then publish:

```bash
npm login
npm publish --access public
```

Interactive modes:

- quick mode: pick boundary migration (recommended)
- manual mode: checkbox migration selection

This project was created using `bun init` in Bun v1.3.5. [Bun](https://bun.com)
is a fast all-in-one JavaScript runtime.
