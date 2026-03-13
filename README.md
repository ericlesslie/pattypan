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

Run without installing:

```bash
npx pattypan
```

If you use Bun:

```bash
bunx pattypan
```

Install globally with npm:

```bash
npm install -g pattypan
```

Then run it as:

```bash
pattypan prisma/migrations
```

## Usage

Primary workflow (boundary-based quick pick):

```bash
npx pattypan prisma/migrations
```

Or, if installed globally:

```bash
pattypan prisma/migrations
```

In quick mode, you:

1. Pick one boundary migration from a newest-first list (page size 5).
2. Tool auto-selects that migration plus all newer migrations.
3. Tool opens a prechecked cherry-pick list where you can uncheck any items.

Non-interactive boundary workflow:

```bash
npx pattypan prisma/migrations --from 20240115094500_add_orders
```

You can also pass a unique fragment:

```bash
npx pattypan prisma/migrations --from add_orders
```

Optional additive exclusions (applied after boundary selection):

```bash
npx pattypan prisma/migrations --from add_orders --exclude production_20240101,production_20240115
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

## Development

If you are working on Pattypan itself:

```bash
bun install
```

```bash
bun run build
```

```bash
bun test
```

Interactive modes:

- quick mode: pick boundary migration (recommended)
- manual mode: checkbox migration selection
