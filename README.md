# ERP prototype

A browser ERP where every module is a spreadsheet-style grid backed by a real database: the speed of Excel with the integrity of an ERP. Done so far: **Phase 1 (Foundation)**, the generic grid, the batch API and the audit log, and **Phase 2 (Inventory)**, which covers stock movements, stock levels, moving-average cost and reversals.

## Requirements

- **Node.js 22** (`node -v` should print v22.x). With nvm-windows: `nvm install 22` then `nvm use 22`.
- **pnpm**: run `corepack enable` once (it ships with Node).
- **Docker Desktop**: needed for production mode and for MongoDB in development. You can skip it and use the in-memory mode below.

## Run in production mode (Docker)

Docker builds and runs the whole app. You don't need Node or pnpm installed for this.

```powershell
docker compose up -d --build     # first build takes a few minutes; later starts are seconds
```

Open **http://localhost:8080**. Starter items and warehouses are added on first start.

| Container | What it runs | Reachable at |
| --- | --- | --- |
| `web` | nginx: the built app, plus a proxy that forwards `/api` to the API | http://localhost:8080 |
| `api` | Node 22 running the API compiled into a single file | Only from `web`, inside Docker |
| `mongo` | MongoDB 7 (single-node replica set), data kept in the `erp_mongo-data` volume | `localhost:27017` from this computer only |

Everyday commands:

```powershell
docker compose ps                  # status (all three should say "healthy")
docker compose logs -f api web     # follow the logs
docker compose up -d --build       # rebuild and restart after changing code
docker compose down                # stop (data is kept)
docker compose down -v             # stop AND delete all data
```

If you have Node and pnpm, `pnpm prod:up`, `pnpm prod:logs` and `pnpm prod:down` do the same.

Settings go in a `.env` file next to `docker-compose.yml` (copy `.env.example`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `WEB_PORT` | `8080` | Port the app is served on. Use `80` to open it at plain http://localhost |
| `MONGO_PORT` | `27017` | Port MongoDB is published on, `127.0.0.1` only |
| `SEED_ON_START` | `true` | Add starter rows to empty sheets. Set to `false` once you use real data |

**Before you put this on a server others can reach:** MongoDB has no password. It is only published on `127.0.0.1` and the API isn't published at all, so it's safe on your own PC. There's no login yet either (Phase 5), so anyone who can open the web port can edit data. For a shared server, put it behind a VPN or a reverse proxy with authentication and HTTPS, and add MongoDB users.

## Run in development mode

```powershell
corepack enable
pnpm install

# Option A: real database
copy .env.example .env
pnpm db:up          # starts only the MongoDB container (first start takes ~20 s to set up the replica set)
pnpm seed           # adds starter warehouses and items (only into empty sheets)
pnpm dev            # API on :3001, web app on http://localhost:5173

# Option B: no database (data resets when you stop it)
pnpm dev:memory
```

Open http://localhost:5173. The dev server reloads as you edit code. Development and production share the same MongoDB data.

## Try the Phase 1 gate

1. Open `samples/items-500.tsv` in Excel (or any text editor), select all, and copy.
2. In the Items sheet, click **Add a row…** and press **Ctrl+V**.
3. 500 rows appear. The 4 deliberately bad ones are flagged: an invalid unit, a non-number cost and a duplicate SKU show as red cells, and the row with no name shows as an incomplete new row. All the valid rows save. Click a red cell to see the reason in the footer.
4. Fix a red cell by typing over it, and that row saves. **Ctrl+Z** undoes the fix, then the whole paste. **Ctrl+Y** redoes them.

You can rebuild the sample with `node scripts/make-sample.mjs`.

## Inventory (Phase 2)

All stock comes from one ledger, **Stock movements**. Every quantity and value you see elsewhere is calculated from it.

| Type | Qty | Unit cost | Rules |
| --- | --- | --- | --- |
| Receipt | more than 0 | Typed, or the item's *Default cost* | Adds stock |
| Issue | more than 0 | Moving average, filled in for you | Can't take a warehouse below 0 |
| Adjustment | + to add, − to remove | +: typed or the average; −: the average | **Reason** required (e.g. "Stock count") |
| Transfer | more than 0 | Moving average | Fill **To warehouse**. Moves stock between warehouses without changing the item's total or value |

**How to use it**

- **Picking items and warehouses:** type a SKU or warehouse code, in any case, or pick from the list that appears as you type. Pasting SKUs and codes from Excel works too.
- **Date:** if you leave it blank, today is filled in.
- **Saved movements are locked.** To undo one, select its row by clicking the row number, then click **Reverse**. That posts an exact opposite movement, and both rows stay visible in grey.
- **Reverse limits:** a movement can be reversed once. Reversing a receipt is refused when its stock has already been used. Post an Adjustment instead.
- **Cost:** moving average per item, across all warehouses. Each receipt re-averages the cost, and everything that leaves stock goes out at the current average. The order of posting counts, not the date typed, so a backdated receipt doesn't re-cost earlier issues.

**Where the numbers show up**

- **Items:** On hand, Avg cost, Stock value and Status. Status says **Reorder** when On hand is at or below the Reorder point.
- **Stock levels:** a read-only report of quantity and value per item and warehouse.
- **Delete protection:** items and warehouses that have movements can't be deleted.

## What works

| Feature | How |
| --- | --- |
| Keyboard editing | Arrows, Tab/Enter, type to edit, F2, Delete clears cells |
| Paste from Excel | Ctrl+V anywhere; rows past the end are created. Handles `1,234.50` and `1.234,50`, € and $ signs, and DD/MM/YYYY dates |
| Validation | Same rules in the browser (instant red cells) and on the server (final say) |
| Autosave | Edits are batched about 0.4 s after you stop typing; one request at a time; cells turn light blue while saving |
| New rows | Saved once every required (*) column is filled; until then the footer lists what's missing |
| Unique columns | SKU and warehouse code, checked case-insensitively against the database and within a paste |
| Conflicts | Every row has a version; if it changed elsewhere, you see the latest value highlighted in amber |
| Undo / redo | Ctrl+Z / Ctrl+Y, and toolbar buttons. A paste is one step; undoing it removes the rows it added |
| Audit log | One record per changed cell (who, when, old → new), written in the same transaction as the change. `GET /api/sheets/items/rows/:id/audit` |
| Computed columns | Grey and read-only, calculated by the server (e.g. Items · On hand, Avg cost) |
| Reference columns | Store the row's id, show its SKU or code, and offer a pick list in the cell editor; renaming a SKU never breaks movements |
| Fill handle, copy, row delete | Drag the corner of a selection; Ctrl+C; select rows by their number and press Delete or **Delete row** |

## Project layout

```
apps/web          React + Vite. SheetView (Glide Data Grid) + SheetModel (edit queue, undo, saving)
apps/api          Fastify. Sheet routes, runBatch (validation, references, unique checks, posting rules, audit)
  src/inventory/  Stock math (balances, moving average), posting rules, Stock levels report, Reverse
packages/schema   Sheet definitions, cell parsing, validation, API types. Shared by web and api
packages/db       SheetStore interface, MongoStore (transactions), MemoryStore (no setup), seed data
samples/          items-500.tsv for the paste test
deploy/           nginx.conf for the web container
Dockerfile        Builds both images: --target api and --target web
```

**Adding a sheet** means adding a definition in `packages/schema/src/sheets/` and listing it in `registry.ts`. The grid, API, validation and audit all pick it up. See `items.ts` for the format. Module logic (posting rules, computed columns, reports, actions) hooks in through `apps/api/src/hooks.ts`. See `inventory/hooks.ts`.

## Tests

```powershell
pnpm test        # 81 tests: parsing, batch rules, inventory costing and stock checks, and the grid model against the real API
pnpm typecheck
```

The MongoDB tests (`apps/api/test/mongo.test.ts`) are skipped unless you point them at a **throwaway** database. The test empties it.

```powershell
$env:MONGO_TEST_URL="mongodb://localhost:27017/erp_test?replicaSet=rs0&directConnection=true"
pnpm --filter @erp/api test
```

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/sheets` | Sheet definitions |
| `GET /api/sheets/:sheet/rows?offset=&limit=` | Rows (default limit 5,000, max 10,000) |
| `POST /api/sheets/:sheet/batch` | `{ updates, inserts, deletes }`: valid parts saved in one transaction, invalid cells returned in `errors` |
| `POST /api/sheets/:sheet/rows/:id/actions/:action` | Row actions, e.g. `stockMovements/rows/<id>/actions/reverse` |
| `GET /api/sheets/:sheet/rows/:id/audit` | Change history for a row |

`GET /api/sheets/stockLevels/rows` returns the calculated report. In a batch, reference columns accept either an id or the display value (`"item": "BOLT-M8"`).

## Notes and limits

- If `pnpm db:up` fails on port 27017, another MongoDB (for example a Windows service) is already using it. Stop it, or change the port in `docker-compose.yml` and `.env`.
- Single user (`local`) until login arrives in Phase 5.
- All rows of a sheet are loaded at once (up to 10,000). Server-side paging and filtering come with saved views.
- Ambiguous dates like 03/04/2026 are read as day/month (`DATE_ORDER` in `packages/schema/src/parse.ts`).
- Undo covers cell edits and pastes, not row deletions. On Stock movements, undo only works before a row saves; after that, use Reverse.
- Stock is checked per batch against the ledger. Two people posting issues for the same item at the same moment could both pass the check. Phase 5 (multi-user) will add a stored stock table that the database checks as well.
- Starter data is only added to a brand-new, empty database.
- The spec named Mongoose; this uses the official MongoDB driver directly instead. Sheet definitions already describe every column, so Mongoose models would repeat them.

## Next: Phase 3 (Purchasing)

Suppliers, purchase orders with line grids, and goods receipts that post Receipt movements automatically, plus supplier bills. Items will also get an *On order* column.
