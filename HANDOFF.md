# Handoff: Excel-like ERP

Last updated 2026-10-13, at the end of Phase 4. Read this first when continuing the project in a new session, then `README.md`.

- **Spec (living doc):** https://claude.ai/code/artifact/ff01ecbe-a073-447d-af4e-1fe4d85ab8fb
- **Repo:** https://github.com/mihailflorin1204/excel-like-erp (branch `master`)
- **Local folder:** `C:\Users\Administrator\ERP` (Windows, Node 22 via nvm-windows, Docker Desktop)

## Status

| Phase | State | Notes |
| --- | --- | --- |
| 1 · Foundation | Done, pushed | Generic grid, batch API, validation, audit log, undo, paste from Excel |
| 2 · Inventory | Done, pushed (`8c2a75c`) | Stock movements ledger, stock levels, moving average, Reverse |
| 3 · Purchasing | Done, pushed (`14a8df2`) | Suppliers, POs, flat PO lines, goods receipts, supplier bills |
| Production setup | Done | `docker compose up -d --build` → http://localhost:8080 |
| 4 · Accounting | Done, **in the folder but not yet pushed** | Chart of accounts, automatic + manual journal entries, bill posting, supplier payments, trial balance, backfill |
| 5 · HR and polish | **Next** | See plan below |

To push Phase 4 (and this file):

```powershell
cd C:\Users\Administrator\ERP
git add -A
git commit -m "Phase 4: accounting (chart of accounts, journal, bill posting, supplier payments, trial balance)"
git push origin master
```

Checks at the end of Phase 4:

- **Tests:** 136 pass (`pnpm test`). 6 MongoDB tests are skipped unless `MONGO_TEST_URL` is set (one new: the purchase-to-payment flow).
- **Builds:** typecheck clean; `pnpm build` passes.
- **Browser:** typed a manual entry and its lines in the grid, posted it, paid a bill with Pay in full, filtered the trial balance by date: balanced, no console errors.
- **Review:** an independent review found 4 bugs and 2 likely ones; all fixed with regression tests (line edit racing Post, also in PO lines; Inventory drifting from stock value by rounding; reversing pre-Phase-4 movements before the backfill; entry-number clashes; receipt reversal not guarding billed receipts or bumping the PO).

## How to resume (prompt for a new session)

Connect the ERP folder, add the GitHub repo as a session source (without it, Claude can't push), then say:

> Continue my Excel-like ERP project in C:\Users\Administrator\ERP. Read HANDOFF.md and README.md first, and the spec doc linked in HANDOFF.md. Next step: Phase 5 (HR and polish). Ask me the open questions listed there before building.

## Decisions already made (don't re-ask)

| Topic | Decision |
| --- | --- |
| Product | Browser app where every module is an Excel-like grid; solo prototype first, single user (`local`) |
| Stack | TypeScript everywhere, Node **22**, pnpm monorepo, React 18 + Vite 7, Glide Data Grid 6, Fastify 5, Zod 3 |
| Database | **MongoDB 7** (user's choice), official driver, single-node replica set for transactions. Not Mongoose: sheet definitions already describe columns |
| Store abstraction | `SheetStore` with `MongoStore` and `MemoryStore`; `pnpm dev:memory` runs with no database |
| Production | Docker Compose: `mongo` + `api` (esbuild bundle) + `web` (nginx serving the app, proxying `/api`), port 8080 |
| Stock | Never negative per warehouse. **Moving average** cost per item across warehouses. Movement types: Receipt, Issue, Adjustment (reason required), Transfer |
| Ledgers | Stock movements and goods receipts are append-only; fix mistakes with **Reverse** (exact opposite, once) |
| PO lines | **One flat sheet** with a PO column (not a split view), filter box plus a "Show lines" drill-down; one line per item per PO |
| Receiving | **Over-receipt blocked**; receipts post stock at the PO line price in the same transaction |
| Bills | **Record + match** per sent PO (billed vs received); accounting entries deferred to Phase 4 |
| Formats | Dates read as day/month (`DATE_ORDER` in `packages/schema/src/parse.ts`); numbers accept `1,234.50` and `1.234,50` |
| Currency, VAT | EUR only, no VAT (confirmed for Phase 4) |
| Chart of accounts | **Simple generic chart** (not Belgian PCMN). Posting accounts found by `role`, created on first start |
| Bills | Draft → **Post** → (Reverse). Clears GRNI up to received-not-billed; excess to price variance only when the PO is fully received or closed, otherwise Post is refused |
| Payments | In Phase 4: Supplier payments ledger against posted bills, plus **Pay in full** |
| Backfill | Existing receipts, bills and adjustments are posted once, on the first start after upgrading |
| Periods / year-end | **Not yet** (user chose to leave them out of Phase 4) |

## How the code fits together

- **A sheet is one definition** (`packages/schema/src/sheets/*.ts`, registered in `registry.ts`): columns, types and flags. The grid, API, validation and audit work from it generically.
- **Column flags:**
  - `required`, `unique` (case-insensitive)
  - `computed` (calculated on read, not stored)
  - `system` (stored, filled by the server)
  - `hidden`
  - `immutable` (editable only on new rows)
  - `ref` (stores a row id, shown and typed as e.g. a SKU)
  - `defaultToday`
- **Sheet flags:**
  - `appendOnly` (ledger)
  - `virtual` (calculated report)
  - `actions` (row buttons)
  - `lockRule` (locks rows by a status value, which can be computed)
  - `drillDown`
  - `refreshAfterSave`
- **Module logic** lives in hooks (`apps/api/src/hooks.ts`; modules in `inventory/hooks.ts`, `purchasing/hooks.ts`, `purchasing/payables.ts` and `accounting/hooks.ts`). Each hook is optional:
  - `computed`, `beforeInsert`, `beforeUpdate`, `beforeDelete`, `virtualRows` (gets the sheet's `params`, e.g. from/to), `actions`
  - Hooks get a `ctx` with the whole batch and can add writes to other sheets via `ctx.related`. Those are saved in the same transaction.
  - `touchInBatch` / `touchPlan` (`apps/api/src/util.ts`) bump the version of rows a save depends on, so racing saves conflict. **Check a row's state on the same read you bump** (see journal lines and PO lines), or a racing Post/Send slips through.
- **Accounting** (`apps/api/src/accounting/posting.ts`):
  - `JournalWriter` collects automatic entries (always balanced, already posted) and returns commit plans. In a grid save use `journalFor(store, ctx)` (saved with the batch); in an action use `journalWriter(store, ctx)` and put `writer.plans()` in `related`.
  - `postMovementEntry` is the one rule for stock movements; `writer.reverse()` posts the opposite of a saved entry and links them.
  - Stock value is the sum of the movements' posted `value`s (`inventory/stock.ts`), and the movement that empties an item takes exactly what is left, so Inventory always equals stock value.
  - `backfill.ts` runs from `app.ts` (`onReady`), only on rows missing the new columns (`store.listWithout`), in chunks.
- **New sheet flags:** `params` (report inputs), `requireOneOf` (e.g. a journal line needs Debit or Credit before it saves), column `indexed` (Mongo index for non-ref lookups).
- **`runBatch`** (`apps/api/src/batch.ts`) runs these steps in order:
  1. validate
  2. lock rules
  3. resolve references
  4. unique checks
  5. delete/update/insert hooks
  6. commit with audit
- **Partial saves:** invalid cells are reported and the rest saves. `allOrNothing` is available for actions.
- **Concurrency:** rows carry a `version`; stale edits come back as conflicts.
  - Purchasing bumps the PO's version on receipts and line changes, so simultaneous changes clash and one is rejected.
  - Action commits use `atomic: true`.
- **Browser side:**
  - `apps/web/src/sheet-model.ts` holds the rows, edit queue, autosave (one batch in flight), undo/redo, and paste. It is plain TypeScript and is unit-tested against the real API.
  - `SheetView.tsx` is the grid UI: filter, pick lists for references, action buttons, and row locks.

## Known limitations and loose ends

- **Stock checks race on Mongo:** two issues for the same item at the same moment could both pass the stock check. The fix planned for Phase 5 is a stored stock table guarded by version.
- **Entry numbers** come from the highest number in use; a clash between two simultaneous saves is retried automatically (`app.ts`). A counter document would be cleaner once there are many users.
- **Trial balance / account balances** read all posted lines per load; move to database-side totals at scale.
- **GRNI leftovers:** a bill below the received value leaves the rest in GRNI; a manual journal entry can clear it, but bill posting doesn't see manual GRNI entries.
- **Old rounding:** movements saved before Phase 4 that emptied an item may have left a cent of value; new ones can't.
- **No login** yet, and MongoDB has no password. Only safe on a local machine (see README).
- **Grid loads whole sheets** (up to 10,000 rows): no server paging or sorting yet.
- **Undo limits:** undo covers edits and pastes, not deletes; on ledgers, use Reverse after a row has saved.
- **Exact filter match:** drill-down filters by text match, so a short typed number like `PO-1` would also match `PO-10`. Auto numbers are fixed-width, so it's fine in practice.
- **Not run here:** MongoDB code paths and the Docker images have never been run in Claude's workspace (MongoDB downloads are blocked there). Covered by review plus `apps/api/test/mongo.test.ts`, which needs a run on the user's machine:

  ```powershell
  $env:MONGO_TEST_URL="mongodb://localhost:27017/erp_test?replicaSet=rs0&directConnection=true"
  pnpm --filter @erp/api test
  ```

- **Demo data on existing databases:** demo data only seeds into a brand-new database. `docker compose down -v` resets everything, **deleting all data**. An existing Phase 3 database is upgraded by the backfill instead.

## Phase 5 plan: HR and polish

- **HR:** departments, employees, expense claims. Approval posts Dr Expense / Cr Employee payable (account 2200 exists in the chart; give it a `role` in `ROLES`).
- **Views:** saved views (filter, sort, hidden columns per sheet) and scratch formula columns (HyperFormula; mind the GPL licence).
- **Login and multi-user:** sign-in and a real user in the audit log; the stored stock table mentioned under known limitations.

**Ask the user before building:**

- Expense claims: paid through Bank directly, or via Employee payable and a payment step (like supplier payments)?
- Departments as cost centres: one expense account per department, or a department column on journal lines?
- Periods and year-end closing: now, or still later?
- Login: simple local accounts, or a provider (Microsoft / Google)?
- Saved views: per user or shared?

## Working notes for Claude

- **Where to build:** in the cloud workspace, then write changed files into the user's folder, checking the folder first so newer user edits are never overwritten.
- **Shell on the user's computer:** still not available (Phase 4 too). Stage the source files in, build and test here, write changed files back. The user runs git and Docker commands themselves.
- **Testing:** use the in-memory store (`pnpm dev:memory`) and Playwright with the preinstalled Chromium for end-to-end browser checks. The grid is a canvas: click cells by position (header ≈ 137px, rows 34px, "Add a row…" at the bottom), pause ~400 ms after the first typed key and after each Tab, or keystrokes get lost. Read results back through the API.
- **Review:** after each phase, have an independent agent review the new logic and the Mongo code paths, then fix and add regression tests. This caught real bugs in every phase so far.
- **Commits:** author `mihial <ai.coding.mihail@gmail.com>` (from the repo history), plus Claude co-author lines. Pushing works only if the repo is a source of the session.
- **Communication:** the user answers design questions quickly with the multiple-choice tool. Ask the open questions per phase before building.
