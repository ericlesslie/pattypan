# Pattypan

Squash Prisma migrations into one compact baseline migration.

The squasher folds compatible `ALTER TABLE` operations into the originating
`CREATE TABLE` so output is a compact schema baseline (instead of appending
retained statements).

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
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
- `--name <migration_name>`: set output migration directory name
- `--latest, -n <count>`: legacy selection mode for latest N migrations
- `--allow-gaps`: legacy latest mode only

Interactive modes:

- quick mode: pick boundary migration (recommended)
- manual mode: checkbox migration selection

This project was created using `bun init` in Bun v1.3.5. [Bun](https://bun.com)
is a fast all-in-one JavaScript runtime.
