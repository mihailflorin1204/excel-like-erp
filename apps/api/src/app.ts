import { ConflictError, DuplicateKeyError, type SheetStore } from '@erp/db';
import { batchRequestSchema, getSheet, sheets } from '@erp/schema';
import Fastify, { type FastifyInstance } from 'fastify';
import { runBatch } from './batch.ts';
import { backfillJournal } from './accounting/backfill.ts';
import { ActionError, applyComputed, hooks } from './hooks.ts';

/** Single local user until login arrives in Phase 5. */
const CURRENT_USER = 'local';

/**
 * Journal entries are numbered from the highest number in use, so two saves that post at the same moment can
 * pick the same number; the database's unique index rejects the second one and nothing of it is saved.
 * Running it again simply takes the next number.
 */
async function retryOnEntryNumberClash<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      const clash = err instanceof DuplicateKeyError && err.sheet === 'journalEntries' && err.column === 'number';
      if (!clash || attempt >= 4) throw err;
    }
  }
}

export function buildApp(store: SheetStore, options: { logger?: boolean } = {}): FastifyInstance {
  // A 5,000-row paste is a few MB of JSON.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 });

  // Before the first request: make sure the posting accounts exist, and give documents saved before
  // accounting existed (Phase 3 data) their journal entries, once.
  app.addHook('onReady', async () => {
    try {
      const summary = await backfillJournal(store);
      if (summary) app.log.info(`Accounting backfill: ${summary}`);
    } catch (err) {
      // Nothing was half-saved (each step is one transaction); it is tried again on the next start.
      app.log.error({ err }, 'Accounting backfill failed; it will be retried on the next start');
    }
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/sheets', async () => ({ sheets }));

  app.get<{ Params: { sheet: string }; Querystring: Record<string, string | undefined> }>(
    '/api/sheets/:sheet/rows',
    async (req, reply) => {
      const sheet = getSheet(req.params.sheet);
      if (!sheet) return reply.code(404).send({ message: `Unknown sheet "${req.params.sheet}"` });
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const limit = Math.min(10_000, Math.max(1, Number(req.query.limit ?? 5_000) || 5_000));
      if (sheet.virtual) {
        // Only the report's declared params, and only as dates (YYYY-MM-DD).
        const params: Record<string, string> = {};
        for (const p of sheet.params ?? []) {
          const value = req.query[p.key];
          if (!value) continue;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return reply.code(400).send({ message: `${p.label} must be a date (YYYY-MM-DD)` });
          params[p.key] = value;
        }
        const all = (await hooks[sheet.key]?.virtualRows?.(store, params)) ?? [];
        return { rows: all.slice(offset, offset + limit), total: all.length };
      }
      const result = await store.listRows(sheet.key, { offset, limit });
      await applyComputed(store, sheet.key, result.rows);
      return result;
    },
  );

  app.post<{ Params: { sheet: string } }>('/api/sheets/:sheet/batch', async (req, reply) => {
    const sheet = getSheet(req.params.sheet);
    if (!sheet) return reply.code(404).send({ message: `Unknown sheet "${req.params.sheet}"` });
    if (sheet.virtual) return reply.code(400).send({ message: `${sheet.label} is a calculated report and can't be edited` });
    const parsed = batchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid batch', issues: parsed.error.issues });
    }
    try {
      return await retryOnEntryNumberClash(() => runBatch(store, sheet, parsed.data, CURRENT_USER));
    } catch (err) {
      if (err instanceof DuplicateKeyError) {
        // Another write claimed the same value between our check and the commit. Nothing was saved.
        return reply.code(409).send({ message: `${err.column} must be unique; nothing was saved, please retry` });
      }
      if (err instanceof ConflictError) {
        // A related record (e.g. the PO of a receipt) changed at the same moment. Nothing was saved.
        return reply.code(409).send({ message: 'Something related changed at the same time; nothing was saved, please retry' });
      }
      throw err;
    }
  });

  // Row actions, e.g. POST /api/sheets/stockMovements/rows/<id>/actions/reverse
  app.post<{ Params: { sheet: string; id: string; action: string } }>(
    '/api/sheets/:sheet/rows/:id/actions/:action',
    async (req, reply) => {
      const sheet = getSheet(req.params.sheet);
      const name = req.params.action;
      const actions = sheet ? hooks[sheet.key]?.actions : undefined;
      // Only actions the sheet declares, looked up as own properties (never e.g. "constructor").
      const declared = sheet?.actions?.some((a) => a.key === name) && actions && Object.hasOwn(actions, name);
      const action = declared ? actions[name] : undefined;
      if (!sheet || !action) return reply.code(404).send({ message: 'Unknown action' });
      try {
        const rows = await retryOnEntryNumberClash(() => action(store, req.params.id, CURRENT_USER));
        return { rows: await applyComputed(store, sheet.key, rows) };
      } catch (err) {
        if (err instanceof ActionError) return reply.code(err.status).send({ message: err.message });
        if (err instanceof ConflictError || err instanceof DuplicateKeyError) {
          // Another save landed at the same moment (e.g. took the same journal entry number). Nothing was saved.
          return reply.code(409).send({ message: 'Something related changed at the same time; nothing was saved, please retry' });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { sheet: string; id: string } }>('/api/sheets/:sheet/rows/:id/audit', async (req, reply) => {
    const sheet = getSheet(req.params.sheet);
    if (!sheet) return reply.code(404).send({ message: `Unknown sheet "${req.params.sheet}"` });
    return { entries: await store.listAudit(sheet.key, req.params.id, 200) };
  });

  return app;
}
