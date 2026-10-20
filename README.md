# ERP prototype

A browser ERP where every module is a spreadsheet-style grid backed by a real database: the speed of Excel with the integrity of an ERP. Done so far:

- **Phase 1 (Foundation):** the generic grid, the batch API and the audit log.
- **Phase 2 (Inventory):** stock movements, stock levels, moving-average cost and reversals.
- **Phase 3 (Purchasing):** suppliers, purchase orders, goods receipts and supplier bills.
- **Phase 4 (Accounting):** chart of accounts, journal entries posted automatically by every document, manual entries, supplier payments and a trial balance.
- **Phase 5 (HR and polish):** sign-in with users and roles, departments, employees and expense claims, a department cost report, saved views, and formula columns.

## Requirements

- **Node.js 22** (`node -v` should print v22.x). With nvm-windows: `nvm install 22` then `nvm use 22`.
- **pnpm**: run `corepack enable` once (it ships with Node).
- **Docker Desktop**: needed for production mode and for MongoDB in development. You can skip it and use the in-memory mode below.

## Run in production mode (Docker)

Docker builds and runs the whole app. You don't need Node or pnpm installed for this.

```powershell
docker compose up -d --build     # first build takes a few minutes; later starts are seconds
```

Open **http://localhost:8080**. On a new installation, the first page asks you to **create the admin account**; do that straight away. Starter data is added on first start.

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
| `AUTH` | `on` | Sign-in. `off` lets everyone in as one admin called "local" (only for trying things alone) |
| `COOKIE_SECURE` | `false` | `true` when people reach the app over https through a proxy that doesn't send `X-Forwarded-Proto` |

**Before you put this on a server others can reach:** MongoDB has no password. It is only published on `127.0.0.1` and the API isn't published at all, so it's safe on your own PC. Everyone must sign in, but the sign-in page and cookies travel in plain http on port 8080. For a shared server, serve it over HTTPS (a reverse proxy in front of `web`), and add MongoDB users. Create the admin account before anyone else can reach a fresh installation: until then, whoever opens it first becomes admin.

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

Open http://localhost:5173. The dev server reloads as you edit code. Development and production share the same MongoDB data. With `pnpm dev:memory` you sign in as **admin@example.com / demo-password** (a demo account that only exists in memory); with a database, the first page asks you to create the admin account.

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

## Purchasing (Phases 3 and 4)

The flow goes **Purchase orders → Purchase order lines → Send → Goods receipts → Supplier bills → Post → Supplier payments**.

1. **Purchase orders:** add a row with Supplier and Deliver to. Leave PO number blank and it is numbered PO-00001, PO-00002, and so on.
2. **Purchase order lines:** one flat sheet for all orders. Type the PO number, item, qty, and price (leave the price blank to use the item's default cost). Each item can appear once per PO. Use the **Filter** box, or select POs and click **Show lines**, to see one order.
3. **Send** the PO by selecting it by its row number and clicking **Send**. Its lines are then locked, and on the header only Expected date and Notes can change.
4. **Goods receipts:** one row per delivery: PO, item, qty, and optionally a warehouse and a delivery note. Each row adds stock at the PO price, as a Receipt in Stock movements, saved together with the receipt.
   - You can't receive more than is outstanding, even across rows of one paste.
   - **Receive all** on a PO receives everything outstanding in one go. If any line can't be received, nothing is posted.
   - Saved receipts are locked. **Reverse** cancels a receipt and its stock together.
5. **Close** a PO when nothing more is coming. Anything outstanding is cancelled.
6. **Supplier bills:** bill number, PO and amount. A new bill is a **draft** and can still be corrected.
   - The supplier and due date (bill date plus the supplier's payment terms) are filled in from the PO.
   - **Match** compares everything billed on the PO with what was received, and flags differences in amber.
   - The same bill number from the same supplier can't be entered twice (unless the first one was reversed).
   - **Post** books the bill (see Accounting) and locks it; only Notes can change afterwards. **Paid**, **Open** and **Status** (Unpaid, Part paid, Paid, Overdue) follow its payments.
   - **Reverse** cancels a posted bill that has no payments.
7. **Supplier payments:** date, supplier, bill no. and amount, against a posted bill. You can't pay more than is open, even across rows of one paste. **Pay in full** on a bill does this in one click. Saved payments are locked; **Reverse** cancels one and opens the bill again.

**On order** on Items and **Open orders** on Suppliers show what is still to be delivered on sent POs.

## Accounting (Phase 4)

Every document posts its own journal entry, in the same transaction as the document itself, so the ledger always matches stock and open bills. Currency is EUR; there is no VAT yet.

**Chart of accounts:** a simple generic chart, created on first start. The accounts below are used by automatic posting; they can be renumbered and renamed, but not deleted or given another type. Add any accounts you like.

| Account | Used for |
| --- | --- |
| 1000 Bank | Supplier payments |
| 1300 Inventory | Stock value (control account) |
| 2000 Accounts payable | Bills and payments (control account) |
| 2100 Goods received not invoiced (GRNI) | Goods receipts and bills |
| 3900 Opening balances | Stock received without a PO |
| 5000 Cost of goods sold | Stock issues |
| 5100 Stock adjustments | Stock adjustments |
| 5200 Purchase price variance | Bills above the received value |

**What posts what:**

| Document | Entry |
| --- | --- |
| Goods receipt | Dr Inventory / Cr GRNI, at the PO price |
| Stock movement: Receipt (typed by hand) | Dr Inventory / Cr Opening balances |
| Stock movement: Issue | Dr Cost of goods sold / Cr Inventory, at the moving average |
| Stock movement: Adjustment | Inventory against Stock adjustments, either way |
| Stock movement: Transfer | Nothing (the value doesn't change) |
| Supplier bill (Post) | Dr GRNI, Dr Purchase price variance (if any) / Cr Accounts payable |
| Supplier payment | Dr Accounts payable / Cr Bank |
| Any Reverse | The exact opposite entry, linked to the original (Status: Reversed / Reversal) |

**Bills and GRNI:** a bill clears GRNI up to what was received on its PO and not billed yet. If it is for more than that:
- while goods are still outstanding, Post is refused: receive the rest first, or **Close** the PO if nothing more is coming;
- once the PO is fully received or closed, the excess goes to Purchase price variance.

A bill for less than the received value leaves the rest in GRNI for a later bill. A goods receipt that is already billed can't be reversed until the bill is reversed.

**Manual entries:**
1. **Journal entries:** add a row and type a memo. The number (JE-00001…) and date fill in if left blank.
2. **Journal lines:** type the entry number, the account code, and a debit **or** a credit. Use **Show lines** on an entry to see its lines.
3. **Post** the entry: it needs at least two lines and debits equal to credits. Posted entries and their lines are locked; **Reverse** posts the opposite entry.

Manual lines can't use Inventory or Accounts payable (control accounts); those only change through their documents. Entries posted by documents can only be reversed from the document.

**Trial balance:** opening balance, debits, credits and closing balance per account, from posted entries. Set **From** and **To** to limit the period. The Total row says **Balanced** or **Out of balance**. On **Chart of accounts**, Balance is debits minus credits, so liabilities, equity and income normally show negative.

**Data from before Phase 4:** on the first start after upgrading, the API posts entries for every stock movement and goods receipt already saved, and posts every existing bill. A bill that can't be posted under the rules above (for example, billed above what was received while goods are still outstanding) becomes a **draft** to fix and post by hand. The API log lists what was done. This happens once; it is safe to restart.

## Users and sign-in (Phase 5)

- **First start:** the app asks for the first admin's name, email and password (at least 10 characters).
- **Adding people:** an admin opens **Admin › Users**, adds a row (email, name, role **Admin** or **Member**), selects it and clicks **Reset password**. The footer shows a temporary password once; give it to the person. At their first sign-in they choose their own.
- **Forgotten password:** an admin clicks **Reset password** again. Everyone can change their own with **Change password** at the bottom of the sidebar.
- **Leaving:** set Status to **Disabled**. They are signed out at once; users are never deleted, so the audit log keeps their name.
- **Admins** manage users and approve, reject, pay and reverse expense claims. **Members** do everything else. Nobody can change their own role, email or status, and there is always at least one active admin.
- The audit log records each change with the email of whoever made it.
- Five wrong passwords in a row lock that email (from that address) for 15 minutes.

## HR (Phase 5)

1. **Departments:** code and name. Headcount counts active employees.
2. **Employees:** code, name, email, department. Give them the **same email as their login**: that is how the app knows a claim is their own. Only admins change employee emails.
3. **Expense claims:** employee, category, amount, and optionally a description, receipt link and expense account (blank = 6300 Travel and expenses). Leave Claim blank to number it EC-00001…
   - **Submit** locks it (only Notes can change).
   - **Approve** (admin) books Dr expense account / Cr 2200 Employee payable, with the employee's department on the lines. Employees › Owed shows what is approved but unpaid.
   - **Pay** (admin) books Dr Employee payable / Cr Bank, dated today.
   - **Reject** (admin) turns a submitted claim down; a rejected claim can be deleted. **Reverse** (admin) cancels an approval that isn't paid yet; the claim is Submitted again.
   - Nobody approves, rejects, pays or reverses a claim they entered, submitted, or that is for themselves.
4. **Department costs:** posted expense lines per department and account, with a total per department, for an optional From/To period. Manual journal lines can carry a department too (Journal lines › Department).

Employee payable (2200) is a control account like Accounts payable: manual journal lines can't use it.

## Views and formula columns (Phase 5)

Under each sheet's title there is a **View** bar:

- **Sort:** click a column header (ascending, descending, off). Editing a row never moves it; new rows stay at the bottom until you sort again or click **Reload**.
- **Columns:** show or hide columns, and freeze the first 0–4 columns.
- **Filter:** the Filter box, as before.
- **+ Formula:** add a calculated column, for example `=[Qty]*[Unit price]` or `=IF([On hand]<[Reorder point],"order","")`. Use a column as `[Name]`; Excel functions such as ROUND, IF, SUM and TEXT work. Formula columns are calculated in your browser for each row and are never saved to the data. Edit or remove them under **Columns**.
- **Save as…** keeps all of that as a named view, private or **shared with everyone**. **Save** updates your own view; **Delete view** removes it (admins can also delete shared views). The last view you used on a sheet opens again next time.

Formula columns use HyperFormula, which is licensed GPLv3 (or commercially). Fine for an internal tool; check the licence before selling this as a product.

## What works

| Feature | How |
| --- | --- |
| Keyboard editing | Arrows, Tab/Enter, type to edit, F2, Delete clears cells |
| Paste from Excel | Ctrl+V anywhere; rows past the end are created. Handles `1,234.50` and `1.234,50`, € and $ signs, and DD/MM/YYYY dates |
| Validation | Same rules in the browser (instant red cells) and on the server (final say) |
| Autosave | Edits are batched about 0.4 s after you stop typing; one request at a time; cells turn light blue while saving |
| New rows | Saved once something is typed and every required (*) column is filled (on Journal lines, a debit or a credit); until then the footer lists what's missing |
| Sort, hide, freeze, formulas | Click a header to sort; the View bar hides and freezes columns, adds formula columns and saves views |
| Unique columns | SKU and warehouse code, checked case-insensitively against the database and within a paste |
| Conflicts | Every row has a version; if it changed elsewhere, you see the latest value highlighted in amber |
| Undo / redo | Ctrl+Z / Ctrl+Y, and toolbar buttons. A paste is one step; undoing it removes the rows it added |
| Audit log | One record per changed cell (who, when, old → new), written in the same transaction as the change. `GET /api/sheets/items/rows/:id/audit` |
| Computed columns | Grey and read-only, calculated by the server (e.g. Items · On hand, Avg cost) |
| Reference columns | Store the row's id, show its SKU or code, and offer a pick list in the cell editor; renaming a SKU never breaks movements |
| Filter | Type in **Filter…** to show matching rows; separate several terms with commas. Rows you edit stay visible until the filter changes |
| Status locks | Sheets can lock rows by status (sent POs and their lines, posted bills and entries). The footer says why a cell can't be edited |
| Fill handle, copy, row delete | Drag the corner of a selection; Ctrl+C; select rows by their number and press Delete or **Delete row** |

## Project layout

```
apps/web          React + Vite. SheetView (Glide Data Grid) + SheetModel (edit queue, undo, saving),
                  Auth (sign-in screens), ViewBar + view-logic (views, sorting, formula columns)
apps/api          Fastify. Sheet routes, runBatch (validation, references, unique checks, posting rules, audit)
  src/inventory/  Stock math (balances, moving average), posting rules, Stock levels report, Reverse
  src/purchasing/ PO numbering, Send/Close/Receive all, receipt posting (with stock movements), bills and payments
  src/accounting/ Chart of accounts, JournalWriter (automatic entries), manual entries, trial balance, backfill
  src/hr/         Departments, employees, expense claims (submit/approve/pay), Department costs report
  src/admin/      Users sheet rules; src/auth.ts sign-in, sessions, passwords; src/views.ts saved views
packages/schema   Sheet definitions, cell parsing, validation, API types. Shared by web and api
packages/db       SheetStore interface, MongoStore (transactions), MemoryStore (no setup), seed data
samples/          items-500.tsv for the paste test
deploy/           nginx.conf for the web container
Dockerfile        Builds both images: --target api and --target web
```

**Adding a sheet** means adding a definition in `packages/schema/src/sheets/` and listing it in `registry.ts`. The grid, API, validation and audit all pick it up. See `items.ts` for the format. Module logic (posting rules, computed columns, reports, actions) hooks in through `apps/api/src/hooks.ts`. See `inventory/hooks.ts`.

## Tests

```powershell
pnpm test        # 168 tests: parsing, batch rules, inventory, purchasing, accounting, HR, sign-in, views, formulas, and the grid model against the real API
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
| `GET /api/auth/me`, `POST /api/auth/setup`, `/login`, `/logout`, `/password` | Sign-in (session cookie `erp_session`) |
| `GET /api/views?sheet=`, `POST /api/views`, `PUT` / `DELETE /api/views/:id` | Saved views |

Every route except `/api/health` and `/api/auth/*` needs a signed-in user. Admin-only sheets (Users) answer 403 to members.

`GET /api/sheets/stockLevels/rows` returns the calculated report; `GET /api/sheets/trialBalance/rows?from=2026-01-01&to=2026-12-31` the trial balance (both dates optional). In a batch, reference columns accept either an id or the display value (`"item": "BOLT-M8"`).

## Notes and limits

- If `pnpm db:up` fails on port 27017, another MongoDB (for example a Windows service) is already using it. Stop it, or change the port in `docker-compose.yml` and `.env`.
- All rows of a sheet are loaded at once (up to 10,000), and sorting, filtering and formulas run in the browser. Server-side paging would be the next step for very large sheets. Formula columns over 10,000 rows take about half a second to recalculate after you stop typing.
- Ambiguous dates like 03/04/2026 are read as day/month (`DATE_ORDER` in `packages/schema/src/parse.ts`).
- Undo covers cell edits and pastes, not row deletions. On Stock movements, undo only works before a row saves; after that, use Reverse.
- Two stock movements of the same item saved at the same moment can't both pass the stock check: each one bumps the item's stock guard in its transaction, so the second is retried and sees the new stock.
- Starter data is only added to a brand-new, empty database. To see the purchasing demo on an existing install, run `docker compose down -v`, which **deletes all data**, then start it again.
- Concurrent changes that depend on the same PO, bill, journal entry or claim (two receipts, a line edit and Send or Post, a payment and a bill reversal) are guarded: one saves and the other is retried or gets "please retry".
- Sign-in attempt limits are kept in memory and reset when the API restarts. Anyone who knows an email can lock it for 15 minutes from their own address.
- If your session ends while you have unsaved edits (for example an admin resets your password), the sign-in screen appears and those unsaved edits are lost.
- Journal entry numbers are taken from the highest number in use. Two saves that post at the same moment can pick the same number; the database refuses the second, and the API retries it automatically.
- Manual entries may post to GRNI (to clear what a short bill left behind, for example). Bill posting works out open GRNI from the documents, so such manual entries are not taken into account there.
- Trial balance and account balances read all posted journal lines on each load. That is fine for a prototype; at a large scale they should move to database-side totals.
- Movements saved before Phase 4 that emptied an item may have left a cent or two of value behind (the old costing rounded per movement). New movements can't: the one that empties an item takes exactly its remaining value.
- The spec named Mongoose; this uses the official MongoDB driver directly instead. Sheet definitions already describe every column, so Mongoose models would repeat them.

## What could come next

The prototype's five phases are done. Candidates for a next round: accounting periods and year-end closing, VAT, sales and customers, server-side paging for very large sheets, and a commercial licence or replacement for HyperFormula if this becomes a product.
