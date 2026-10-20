import { type BatchError, type Row, sessionsSheet, usersSheet } from '@erp/schema';
import { endSessionsOf, hasPassword, requireAdmin, setPassword, temporaryPassword } from '../auth.ts';
import { ActionError, type SheetHooks } from '../hooks.ts';
import { str, touchInBatch } from '../util.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const status = (values: Row['values']) => str(values.status) ?? 'Active';
const same = (a: unknown, b: unknown) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export const adminHooks: Record<string, SheetHooks> = {
  users: {
    async beforeInsert(_store, inserts) {
      const errors: BatchError[] = [];
      for (const ins of inserts) {
        if (!EMAIL.test(String(ins.values.email ?? '').trim())) {
          errors.push({ op: 'insert', ref: ins.tempId, column: 'email', message: 'Enter a valid email' });
          continue;
        }
        ins.values.email = String(ins.values.email).trim();
        ins.values.status = str(ins.values.status) ?? 'Active';
        ins.values.lastSignIn = null;
      }
      return errors;
    },

    /** Nobody can lock themselves out, and at least one active admin always remains. */
    async beforeUpdate(store, updates, ctx) {
      const errors: BatchError[] = [];
      for (const u of updates) {
        if ('email' in u.set && !EMAIL.test(String(u.set.email ?? '').trim())) {
          errors.push({ op: 'update', ref: u.id, column: 'email', message: 'Enter a valid email' });
        }
        if (same(u.current.values.email, ctx.user)) {
          if ('email' in u.set && !same(u.set.email, u.current.values.email)) {
            errors.push({ op: 'update', ref: u.id, column: 'email', message: "You can't change your own email; ask another admin" });
          }
          if ('role' in u.set && u.set.role !== u.current.values.role) {
            errors.push({ op: 'update', ref: u.id, column: 'role', message: "You can't change your own role; ask another admin" });
          }
          if ('status' in u.set && (str(u.set.status) ?? 'Active') !== 'Active') {
            errors.push({ op: 'update', ref: u.id, column: 'status', message: "You can't disable your own account" });
          }
        }
      }
      const blocked = new Set(errors.map((e) => `${e.ref}|${e.column}`));
      const after = new Map((await store.listWhere('users', 'email')).map((r) => [r.id, { ...r.values }]));
      for (const u of updates) {
        for (const [k, v] of Object.entries(u.set)) if (!blocked.has(`${u.id}|${k}`)) after.get(u.id)![k] = v;
      }
      const admins = [...after.values()].filter((v) => v.role === 'Admin' && status(v) === 'Active');
      const changingAccess = updates.filter((x) => 'role' in x.set || 'status' in x.set);
      if (admins.length === 0) {
        for (const u of changingAccess) {
          errors.push({ op: 'update', ref: u.id, column: 'role' in u.set ? 'role' : 'status', message: 'At least one active admin must remain' });
        }
      }
      if (changingAccess.length > 0) {
        // Two admins demoting each other at the same moment: bumping every admin makes one of them conflict.
        const current = await store.listWhere('users', 'email');
        touchInBatch(ctx, usersSheet, current.filter((r) => r.values.role === 'Admin' && status(r.values) === 'Active' && !updates.some((u) => u.id === r.id)));
      }
      // Disabled users are signed out everywhere (re-enabling them doesn't bring old sessions back).
      const disabled = updates.filter((u) => 'status' in u.set && (str(u.set.status) ?? 'Active') !== 'Active' && !blocked.has(`${u.id}|status`));
      if (disabled.length > 0) {
        const sessions = await store.listWhere(sessionsSheet.key, 'user', disabled.map((u) => u.id));
        if (sessions.length > 0) {
          ctx.related.push(() => ({ sheet: sessionsSheet, inserts: [], updates: [], deletes: sessions.map((r) => ({ id: r.id, expectedVersion: r.version })), audit: [] }));
        }
      }
      return errors;
    },

    async beforeDelete(_store, rows) {
      // Their name stays in the audit log; disabling keeps that meaningful.
      return rows.map((r) => ({ op: 'delete' as const, ref: r.id, message: 'Users are not deleted: set Status to Disabled instead' }));
    },

    async computed(store, rows) {
      const passwords = await hasPassword(store, rows.map((r) => r.id));
      for (const r of rows) r.values.hasPassword = passwords.get(r.id) ?? 'Not set';
    },

    actions: {
      async resetPassword(store, id, user) {
        await requireAdmin(store, user, 'reset passwords');
        const [target] = await store.getRows('users', [id]);
        if (!target) throw new ActionError(404, 'User not found');
        if (status(target.values) !== 'Active') throw new ActionError(409, `${target.values.email} is disabled; set Status to Active first`);
        const password = temporaryPassword();
        await setPassword(store, id, password, true, user);
        await endSessionsOf(store, id);
        const rows = await store.getRows('users', [id]);
        return {
          rows,
          message: `Temporary password for ${target.values.email}: ${password} (shown only now). They choose their own at sign-in.`,
        };
      },
    },
  },
};
