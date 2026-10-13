# Handoff: Excel-like ERP

Last updated 2026-10-13, at the end of Phase 3. Read this first when continuing the project in a new session, then `README.md`.

- **Spec (living doc):** https://claude.ai/code/artifact/ff01ecbe-a073-447d-af4e-1fe4d85ab8fb
- **Repo:** https://github.com/mihailflorin1204/excel-like-erp (branch `master`)
- **Local folder:** `C:\Users\Administrator\ERP` (Windows, Node 22 via nvm-windows, Docker Desktop)

## Status

| Phase | State | Notes |
| --- | --- | --- |
| 1 · Foundation | Done, pushed | Generic grid, batch API, validation, audit log, undo, paste from Excel |
| 2 · Inventory | Done, pushed (`8c2a75c`) | Stock movements ledger, stock levels, moving average, Reverse |
| 3 · Purchasing | Done, **in the folder but not yet pushed** | Suppliers, POs, flat PO lines, goods receipts, supplier bills |
| Production setup | Done | `docker compose up -d --build` → http://localhost:8080 |
| 4 · Accounting | **Next** | See plan below |
| 5 · HR and polish | Later | See plan below |

To push Phase 3 (and this file):

```powershell
cd C:\Users\Administrator\ERP
git add -A
git commit -m "Phase 3: purchasing (suppliers, POs, goods receipts, supplier bills)"
git push origin master
```

Checks at the end of Phase 3:

- **Tests:** 101 pass (`pnpm test`). 5 MongoDB tests are skipped unless `MONGO_TEST_URL` is set.
- **Builds:** typecheck clean; `pnpm build` passes.
- **Browser:** the end-to-end purchase-to-bill flow worked.

## How to resume (prompt for a new session)

Connect the ERP folder, add the GitHub repo as a session source (without it, Claude can't push), then say:

> Continue my Excel-like ERP project in C:\Users\Administrator\ERP. Read HANDOFF.md and README.md first, and the spec doc linked in HANDOFF.md. Next step: Phase 4 (Accounting). Ask me the open questions listed there before building.

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
| Assumed, not confirmed | Single currency (EUR), no VAT. **Confirm before Phase 4** |

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
- **Module logic** lives in hooks (`apps/api/src/hooks.ts`; modules in `inventory/hooks.ts` and `purchasing/hooks.ts`). Each hook is optional:
  - `computed`, `beforeInsert`, `beforeUpdate`, `beforeDelete`, `virtualRows`, `actions`
  - Hooks get a `ctx` with the whole batch and can add writes to other sheets via `ctx.related`. Those are saved in the same transaction.
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

- **Stock checks race on Mongo:** two issues for the same item at the same moment, or a receipt reversal racing an issue, could both pass the stock check. The fix planned for Phase 5 is a stored stock table guarded by version.
- **No login** yet, and MongoDB has no password. Only safe on a local machine (see README).
- **Grid loads whole sheets** (up to 10,000 rows): no server paging or sorting yet.
- **Undo limits:** undo covers edits and pastes, not deletes; on ledgers, use Reverse after a row has saved.
- **Exact filter match:** drill-down filters by text match, so a short typed PO number like `PO-1` would also match `PO-10`. Auto numbers are fixed-width, so it's fine in practice.
- **Not run here:** MongoDB code paths, and the Docker images build, have never been run in Claude's workspace (no registry or MongoDB downloads there). They are covered by careful review plus `apps/api/test/mongo.test.ts`, which needs a run on the user's machine:

  ```powershell
  $env:MONGO_TEST_URL="mongodb://localhost:27017/erp_test?replicaSet=rs0&directConnection=true"
  pnpm --filter @erp/api test
  ```

- **Demo data on existing databases:** demo data only seeds into a brand-new database. `docker compose down -v` resets everything, **deleting all data**.

## Phase 4 plan: Accounting

**Goal:** a trial balance that balances after the demo flow.

1. **Chart of accounts** sheet: code, name, type (asset, liability, equity, income, expense).
2. **Journal entries** as an append-only ledger with lines (account, debit, credit). An entry must balance to post; fix mistakes with Reverse. Probably a flat lines sheet with an entry column, like PO lines.
3. **Automatic posting** through `ctx.related`, in the same transaction as the document:
   - Goods receipt: Dr Inventory / Cr Goods received not invoiced (GRNI)
   - Supplier bill: Dr GRNI / Cr Accounts payable (with a price-variance line if it differs)
   - Stock adjustment: Dr/Cr Inventory against a stock adjustment account
   - Reversals post reversed entries.
4. **Trial balance** as a virtual sheet: debit and credit totals per account for a date range.
5. Bills become **locked once posted** (today they're editable).

**Ask the user before building:**

- Which chart of accounts? The Belgian standard chart (PCMN/MAR) or a simple generic one.
- VAT: in scope now? Rates, and accounts 411/451.
- Currency: EUR only?
- Should existing receipts, bills and adjustments be posted retroactively when Phase 4 is installed?
- Periods and year-end closing: needed now, or later?
- Supplier payments: in Phase 4?

## Phase 5 plan: HR and polish

- **HR:** departments, employees, expense claims. Approval posts Dr Expense / Cr Employee payable.
- **Views:** saved views (filter, sort, hidden columns per sheet) and scratch formula columns (HyperFormula; mind the GPL licence).
- **Login and multi-user:** sign-in and a real user in the audit log; the stored stock table mentioned under known limitations.

## Working notes for Claude

- **Where to build:** in the cloud workspace, then write changed files into the user's folder, checking the folder first so newer user edits are never overwritten.
- **Shell on the user's computer:** not available so far. The user runs git and Docker commands themselves.
- **Testing:** use the in-memory store (`pnpm dev:memory`) and Playwright with the preinstalled Chromium for end-to-end browser checks. Glide's cell editor needs a short pause after the first typed key.
- **Review:** after each phase, have an independent agent review the new logic and the Mongo code paths, then fix and add regression tests. This caught real bugs in every phase so far.
- **Commits:** author `mihial <ai.coding.mihail@gmail.com>` (from the repo history), plus Claude co-author lines. Pushing works only if the repo is a source of the session.
- **Communication:** the user answers design questions quickly with the multiple-choice tool. Ask the open questions per phase before building.
