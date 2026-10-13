import { defineSheet } from '../types.ts';

export const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'] as const;
export const ENTRY_STATES = ['Draft', 'Posted'] as const;

/**
 * The chart of accounts. Accounts with a role (Inventory, Accounts payable…) are the ones automatic posting
 * uses; they are created on first start and can be renamed but not deleted or retyped.
 */
export const accountsSheet = defineSheet({
  key: 'accounts',
  label: 'Chart of accounts',
  module: 'accounting',
  description: 'Balance = debits − credits, so liability, equity and income accounts normally show a negative balance.',
  columns: [
    { key: 'code', label: 'Code', type: 'text', required: true, unique: true, maxLength: 20, width: 90 },
    { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 120, width: 240 },
    { key: 'type', label: 'Type', type: 'enum', required: true, options: ACCOUNT_TYPES, width: 100 },
    { key: 'usedFor', label: 'Automatic posting', type: 'text', computed: true, width: 220 },
    { key: 'debit', label: 'Debit', type: 'currency', computed: true, width: 115 },
    { key: 'credit', label: 'Credit', type: 'currency', computed: true, width: 115 },
    { key: 'balance', label: 'Balance', type: 'currency', computed: true, width: 115 },
    // Which automatic posting rule uses this account (inventory, payable…); set by the system.
    { key: 'role', label: 'Role', type: 'text', system: true, hidden: true },
  ],
});

/**
 * Journal entry headers. Manual entries start as drafts: add lines in Journal lines, then Post.
 * Entries posted by documents (goods receipts, bills, payments, stock movements) arrive already posted.
 */
export const journalEntriesSheet = defineSheet({
  key: 'journalEntries',
  label: 'Journal entries',
  module: 'accounting',
  description: 'Type a memo to start an entry (number and date fill in if left blank). Add lines in Journal lines, then Post. Posted entries are locked; use Reverse.',
  drillDown: { label: 'Show lines', sheet: 'journalLines', column: 'number' },
  actions: [
    { key: 'post', label: 'Post', description: 'Post a balanced draft entry to the ledger; it is locked afterwards' },
    { key: 'reverse', label: 'Reverse', description: 'Post an opposite entry that cancels a posted manual entry' },
  ],
  lockRule: {
    column: 'state',
    editableWhen: ['Draft'],
    deletableWhen: ['Draft'],
    message: 'This entry is posted and locked. Use Reverse to cancel it.',
  },
  columns: [
    { key: 'number', label: 'Entry', type: 'text', unique: true, maxLength: 20, width: 110 },
    { key: 'date', label: 'Date', type: 'date', defaultToday: true, width: 110 },
    { key: 'memo', label: 'Memo', type: 'text', maxLength: 200, width: 280 },
    { key: 'origin', label: 'Origin', type: 'text', system: true, width: 130 },
    { key: 'debit', label: 'Debit', type: 'currency', computed: true, width: 110 },
    { key: 'credit', label: 'Credit', type: 'currency', computed: true, width: 110 },
    { key: 'lineCount', label: 'Lines', type: 'number', computed: true, width: 70 },
    { key: 'status', label: 'Status', type: 'text', computed: true, width: 150 },
    { key: 'state', label: 'State', type: 'enum', options: ENTRY_STATES, system: true, hidden: true, indexed: true },
    // The document that posted this entry (sheet key and row id); empty for manual entries.
    { key: 'source', label: 'Source', type: 'text', system: true, hidden: true },
    { key: 'sourceId', label: 'Source id', type: 'text', system: true, hidden: true },
    { key: 'reversalOf', label: 'Reversal of', type: 'text', system: true, hidden: true },
    { key: 'reversedBy', label: 'Reversed by', type: 'text', system: true, hidden: true },
  ],
});

/** Every journal line in one flat sheet, like PO lines. Filter on an entry number to see one entry. */
export const journalLinesSheet = defineSheet({
  key: 'journalLines',
  label: 'Journal lines',
  module: 'accounting',
  description: 'One row per account per entry: a debit or a credit. Lines can be changed while the entry is a draft.',
  requireOneOf: [['debit', 'credit']],
  lockRule: {
    column: 'entryState',
    editableWhen: ['Draft'],
    message: 'The entry is posted, so its lines are locked.',
  },
  columns: [
    { key: 'entry', label: 'Entry', type: 'ref', required: true, immutable: true, ref: { sheet: 'journalEntries', display: 'number' }, width: 110 },
    { key: 'account', label: 'Account', type: 'ref', required: true, ref: { sheet: 'accounts', display: 'code' }, width: 100 },
    { key: 'accountName', label: 'Account name', type: 'text', computed: true, width: 210 },
    { key: 'debit', label: 'Debit', type: 'currency', min: 0, width: 110 },
    { key: 'credit', label: 'Credit', type: 'currency', min: 0, width: 110 },
    { key: 'memo', label: 'Memo', type: 'text', maxLength: 200, width: 240 },
    { key: 'date', label: 'Date', type: 'date', computed: true, width: 110 },
    { key: 'status', label: 'Status', type: 'text', computed: true, width: 110 },
    { key: 'entryState', label: 'Entry state', type: 'text', computed: true, hidden: true },
  ],
});

/** Report: debit and credit totals per account for a date range, from posted entries. */
export const trialBalanceSheet = defineSheet({
  key: 'trialBalance',
  label: 'Trial balance',
  module: 'accounting',
  description: 'Posted entries only. Opening = balance before From; Closing = Opening + Debit − Credit. Read-only.',
  virtual: true,
  params: [
    { key: 'from', label: 'From' },
    { key: 'to', label: 'To' },
  ],
  columns: [
    { key: 'account', label: 'Account', type: 'ref', ref: { sheet: 'accounts', display: 'code' }, computed: true, width: 100 },
    { key: 'name', label: 'Name', type: 'text', computed: true, width: 240 },
    { key: 'type', label: 'Type', type: 'text', computed: true, width: 100 },
    { key: 'opening', label: 'Opening', type: 'currency', computed: true, width: 120 },
    { key: 'debit', label: 'Debit', type: 'currency', computed: true, width: 120 },
    { key: 'credit', label: 'Credit', type: 'currency', computed: true, width: 120 },
    { key: 'closing', label: 'Closing', type: 'currency', computed: true, width: 120 },
    { key: 'check', label: 'Check', type: 'text', computed: true, width: 130 },
  ],
});
