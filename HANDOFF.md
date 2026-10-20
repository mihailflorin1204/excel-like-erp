# Handoff: Excel-like ERP

Last updated 2026-10-20, at the end of Phase 5. Read this first when continuing the project in a new session, then `README.md`.

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
| 4 · Accounting | Done, pushed (`0f811ec`) | Chart of accounts, automatic + manual journal entries, bill posting, supplier payments, trial balance, backfill |
| 5 · HR and polish | Done, **in the folder but not yet pushed** | Login and users, HR and expense claims, department costs, stock guard, saved views, formula columns |

To push Phase 5 (and this file). `pnpm install` picks up the one new package (HyperFormula):

```powershell
cd C:\Users\Administrator\ERP
pnpm install
git add -A
git commit -m "Phase 5: login, HR and expense claims, saved views, formula columns"
git push origin master
```

Checks at the end of Phase 5:

- **Tests:** 168 pass (`pnpm test`). 7 MongoDB tests are skipped unless `MONGO_TEST_URL` is set (new: sign-in, claim posting and views on Mongo).
- **Builds:** typecheck clean; `pnpm build` passes (HyperFormula is a separate chunk, loaded only when a view has formula columns).
- **Browser:** signed in, approved a claim, read Department costs, added a formula column, hid columns, saved a shared view (restored after reload), added a member and reset their password, the member was forced to choose a password and saw the shared view but not Users; sorted Items and edited a row (it stayed put); deleted the view; signed out. No console errors.
- **Review:** an independent review found 7 bugs; all fixed with regression tests: sign-in bypass with a full URL in the request line (now deny-by-default on the matched route), parallel password guessing past the lockout, old password hashes in the audit log, an admin able to approve their own claim by changing emails, Delete view failing in the browser, sorted rows jumping while editing, formulas recalculating on every edit.

## How to resume (prompt for a new session)

Connect the ERP folder, add the GitHub repo as a session source (without it, Claude can't push), then say:

> Continue my Excel-like ERP project in C:\Users\Administrator\ERP. Read HANDOFF.md and README.md first, and the spec doc linked in HANDOFF.md. Next step: see "What could come next". Ask me the open questions there before building.

## Decisions already made (don't re-ask)

| Topic | Decision |
| --- | --- |
| Product | Browser app where every module is an Excel-like grid; prototype, now multi-user with sign-in |
| Stack | TypeScript everywhere, Node **22**, pnpm monorepo, React 18 + Vite 7, Glide Data Grid 6, Fastify 5, Zod 3 |
| Database | **MongoDB 7** (user's choice), official driver, single-node replica set for transactions. Not Mongoose: sheet definitions already describe columns |
| Store abstraction | `SheetStore` with `MongoStore` and `MemoryStore`; `pnpm dev:memory` runs with no database |
| Production | Docker Compose: `mongo` + `api` (esbuild bundle) + `web` (nginx serving the app, proxying `/api`), port 8080 |
| Stock | Never negative per warehouse. **Moving average** cost per item across warehouses. Movement types: Receipt, Issue, Adjustment (reason required), Transfer |
| Ledgers | Stock movements and goods receipts are append-only; fix mistakes with **Reverse** (exact opposite, once) |
| PO lines | **One flat sheet** with a PO column (not a split view), filter box plus a "Show lines" drill-down; one line per item per PO |
| Receiving | **Over-receipt blocked**; receipts post stock at the PO line price in the same transaction |
| Formats | Dates read as day/month (`DATE_ORDER` in `packages/schema/src/parse.ts`); numbers accept `1,234.50` and `1.234,50` |
| Currency, VAT | EUR only, no VAT (confirmed for Phase 4) |
| Chart of accounts | **Simple generic chart** (not Belgian PCMN). Posting accounts found by `role`, created on first start |
| Bills | Draft → **Post** → (Reverse). Clears GRNI up to received-not-billed; excess to price variance only when the PO is fully received or closed, otherwise Post is refused |
| Payments | In Phase 4: Supplier payments ledger against posted bills, plus **Pay in full** |
| Backfill | Existing receipts, bills and adjustments are posted once, on the first start after upgrading |
| Periods / year-end | **Not yet** (left out of Phases 4 and 5) |
| Login | **Simple local accounts**: email + password (scrypt), sessions in the database, httpOnly cookie. Roles **Admin** / **Member**. First visitor of a fresh install creates the admin. `AUTH=off` for single-user use |
| Expense claims | Draft → Submit → **Approve** (Dr expense with department / Cr 2200 Employee payable) → **Pay** (Dr 2200 / Cr Bank). Reject; Reverse an unpaid approval. Admins decide, never on their own claim (user picked the recommended options by default) |
| Cost centres | **Department column on journal lines**, filled from the employee by claims; Department costs report |
| Saved views | Per sheet; **private or shared**; owner edits, owner or admin deletes. Sort, filter, hidden/frozen columns, formula columns |
| Formulas | HyperFormula (GPLv3, `licenseKey: 'gpl-v3'`) in the browser, `[Column]` references per row, never stored |

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
  - `SheetView.tsx` is the grid UI: filter, pick lists for references, action buttons, and row locks. It works on **shown columns** (`view-logic.ts`: visible sheet columns plus formula columns), so always map a grid column index through `shown[col]`, never `model.columns[col]`.
  - Row order under a filter or sort is **frozen** (`frozenOrder`) and recomputed only when the filter/sort/formulas change, on first load and on Reload; edits never move rows.
  - `ViewBar.tsx` (views, columns panel, formula editor); `Auth.tsx` (setup, sign-in, forced password change, user menu).
- **Sign-in** (`apps/api/src/auth.ts`, `app.ts`): every route needs a session unless declared with `{ config: { public: true } }`; the check uses the matched route, never the URL text. Actions and hooks get the user's email as `user`; `actorOf` / `requireAdmin` turn it into a role. `local`, `seed` and `system` are system users with admin rights.
- **Internal collections** (`internalSheets`: credentials, sessions, views, stockGuards) are `internal: true` sheets: the store indexes them, the sheet routes never serve them. Pass `[...sheets, ...internalSheets]` to `store.init`.
- **Stock guard:** `guardStock` (inventory/hooks.ts) bumps a per-item row in every movement's transaction; `retryOnClash` (app.ts) reruns a save that lost a race (ConflictError or DuplicateKeyError).

## Known limitations and loose ends

- **Entry numbers** come from the highest number in use; a clash between two simultaneous saves is retried automatically (`app.ts`). A counter document would be cleaner once there are many users.
- **Trial balance / account balances** read all posted lines per load; move to database-side totals at scale.
- **GRNI leftovers:** a bill below the received value leaves the rest in GRNI; a manual journal entry can clear it, but bill posting doesn't see manual GRNI entries.
- **Old rounding:** movements saved before Phase 4 that emptied an item may have left a cent of value; new ones can't.
- **MongoDB has no password**, and sign-in runs over plain http on port 8080. Put HTTPS in front before sharing beyond a trusted network (see README).
- **Sign-in limits are in memory** and reset on restart; anyone can lock an email for 15 minutes from their own address.
- **Grid loads whole sheets** (up to 10,000 rows); sort, filter and formulas run in the browser (formulas ≈ 0.5 s per recalculation at 10,000 rows, after a pause in typing).
- **Unsaved edits are lost** if the session ends mid-edit (sign-in screen replaces the app).
- **Formula values:** text such as `TRUE` or an ISO date becomes a boolean or a date number inside formulas.
- **Undo limits:** undo covers edits and pastes, not deletes; on ledgers, use Reverse after a row has saved.
- **Exact filter match:** drill-down filters by text match, so a short typed number like `PO-1` would also match `PO-10`. Auto numbers are fixed-width, so it's fine in practice.
- **Not run here:** MongoDB code paths and the Docker images have never been run in Claude's workspace (MongoDB downloads are blocked there). Covered by review plus `apps/api/test/mongo.test.ts`, which needs a run on the user's machine:

  ```powershell
  $env:MONGO_TEST_URL="mongodb://localhost:27017/erp_test?replicaSet=rs0&directConnection=true"
  pnpm --filter @erp/api test
  ```

- **Demo data on existing databases:** demo data only seeds into a brand-new database. `docker compose down -v` resets everything, **deleting all data**. An existing Phase 3 database is upgraded by the backfill instead.

## What could come next

All five planned phases are done. Possible next rounds (ask the user which, and these questions, before building):

- **Periods and year-end:** lock closed months; roll income and expenses into retained earnings (3100) at year end. Which period length, and who may reopen a period?
- **VAT:** Belgian rates on bills (and later sales), accounts 411/451. Which rates, and is a VAT return report needed?
- **Sales:** customers, sales orders, deliveries (stock issues at average cost are already in place), invoices and receipts (accounts 1200 receivable, 4000 sales).
- **Scale:** server-side paging/sorting/filtering for sheets beyond ~10,000 rows; formulas in a Web Worker.
- **Licence:** keep HyperFormula (GPLv3) for internal use, buy a licence, or replace it if this becomes a product.

## Working notes for Claude

- **Where to build:** in the cloud workspace, then write changed files into the user's folder, checking the folder first so newer user edits are never overwritten.
- **Shell on the user's computer:** still not available (Phases 4 and 5 too). Stage the source files in, build and test here, write changed files back. The user runs git and Docker commands themselves.
- **Testing:** use the in-memory store (`pnpm dev:memory`, sign in as admin@example.com / demo-password) and Playwright with the preinstalled Chromium for end-to-end browser checks. The grid is a canvas: click cells by position (read the grid's top from `.grid-wrap`'s bounding box; header 36px, rows 34px, "Add a row…" at the bottom), pause ~400 ms after the first typed key and after each Tab, or keystrokes get lost. Read results back through the API.
- **Review:** after each phase, have an independent agent review the new logic and the Mongo code paths, then fix and add regression tests. This caught real bugs in every phase so far. When proving a race with the `interrupted` store helper (accounting.test.ts), check the test fails without the fix: journal number clashes can hide races.
- **API tests** build the app with `buildApp(store, { auth: false })`; auth and HR tests sign in for real.
- **Commits:** author `mihial <ai.coding.mihail@gmail.com>` (from the repo history), plus Claude co-author lines. Pushing works only if the repo is a source of the session.
- **Communication:** the user answers design questions quickly with the multiple-choice tool. Ask the open questions per phase before building.
