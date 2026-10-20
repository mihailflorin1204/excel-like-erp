import { defineSheet, type SheetDef } from '../types.ts';

export const USER_ROLES = ['Admin', 'Member'] as const;
export const USER_STATUSES = ['Active', 'Disabled'] as const;

/** People who can sign in. Admins only. Passwords are kept elsewhere, never in this sheet. */
export const usersSheet = defineSheet({
  key: 'users',
  label: 'Users',
  module: 'admin',
  adminOnly: true,
  description: 'Who can sign in. Admins manage users and approve claims. New user or forgotten password: Reset password gives a temporary one.',
  actions: [
    { key: 'resetPassword', label: 'Reset password', description: 'Make a temporary password for the user (shown once); they choose a new one at next sign-in' },
  ],
  columns: [
    { key: 'email', label: 'Email', type: 'text', required: true, unique: true, maxLength: 120, width: 230 },
    { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 120, width: 200 },
    { key: 'role', label: 'Role', type: 'enum', required: true, options: USER_ROLES, width: 100 },
    { key: 'status', label: 'Status', type: 'enum', options: USER_STATUSES, width: 100 },
    { key: 'hasPassword', label: 'Password', type: 'text', computed: true, width: 130 },
    { key: 'lastSignIn', label: 'Last sign-in', type: 'text', system: true, width: 170 },
  ],
});

/**
 * Collections the server keeps for itself. They are never listed by /api/sheets and can't be read or written
 * through the sheet routes; they only exist so the store can index and save them.
 */
export const credentialsSheet: SheetDef = defineSheet({
  key: 'credentials',
  label: 'Credentials',
  module: 'admin',
  internal: true,
  columns: [
    { key: 'user', label: 'User', type: 'text', unique: true },
    { key: 'hash', label: 'Hash', type: 'text', maxLength: 300 },
    { key: 'mustChange', label: 'Must change', type: 'text' },
  ],
});

export const sessionsSheet: SheetDef = defineSheet({
  key: 'sessions',
  label: 'Sessions',
  module: 'admin',
  internal: true,
  columns: [
    { key: 'tokenHash', label: 'Token hash', type: 'text', unique: true },
    { key: 'user', label: 'User', type: 'text', indexed: true },
    { key: 'expiresAt', label: 'Expires at', type: 'text' },
  ],
});

/** Saved grid views: filter, sort, hidden and frozen columns, formula columns. `config` is JSON. */
export const viewsSheet: SheetDef = defineSheet({
  key: 'views',
  label: 'Views',
  module: 'admin',
  internal: true,
  columns: [
    { key: 'sheet', label: 'Sheet', type: 'text', indexed: true },
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'owner', label: 'Owner', type: 'text' },
    { key: 'shared', label: 'Shared', type: 'text' },
    { key: 'config', label: 'Config', type: 'text', maxLength: 100_000 },
  ],
});

/**
 * One row per item, bumped by every stock movement of that item in the same transaction, so two movements of
 * the same item saved at the same moment can't both pass the stock check (the second one conflicts).
 */
export const stockGuardsSheet: SheetDef = defineSheet({
  key: 'stockGuards',
  label: 'Stock guards',
  module: 'inventory',
  internal: true,
  columns: [{ key: 'item', label: 'Item', type: 'text', unique: true }],
});

export const internalSheets: readonly SheetDef[] = [credentialsSheet, sessionsSheet, viewsSheet, stockGuardsSheet];
