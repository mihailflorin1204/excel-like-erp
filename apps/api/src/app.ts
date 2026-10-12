import { DuplicateKeyError, type SheetStore } from '@erp/db';
import { batchRequestSchema, getSheet, sheets } from '@erp/schema';
import Fastify, { type FastifyInstance } from 'fastify';
import { runBatch } from './batch.ts';
import { applyComputed } from './computed.ts';

/** Single local user until login arrives in Phase 5. */
const CURRENT_USER = 'local';

export function buildApp(store: SheetStore, options: { logger?: boolean } = {}): FastifyInstance {
  // A 5,000-row paste is a few MB of JSON.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/sheets', async () => ({ sheets }));

  app.get<{ Params: { sheet: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/sheets/:sheet/rows',
    async (req, reply) => {
      const sheet = getSheet(req.params.sheet);
      if (!sheet) return reply.code(404).send({ message: `Unknown sheet "${req.params.sheet}"` });
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const limit = Math.min(10_000, Math.max(1, Number(req.query.limit ?? 5_000) || 5_000));
      const result = await store.listRows(sheet.key, { offset, limit });
      await applyComputed(store, sheet.key, result.rows);
      return result;
    },
  );

  app.post<{ Params: { sheet: string } }>('/api/sheets/:sheet/batch', async (req, reply) => {
    const sheet = getSheet(req.params.sheet);
    if (!sheet) return reply.code(404).send({ message: `Unknown sheet "${req.params.sheet}"` });
    const parsed = batchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid batch', issues: parsed.error.issues });
    }
    try {
      return await runBatch(store, sheet, parsed.data, CURRENT_USER);
    } catch (err) {
      if (err instanceof DuplicateKeyError) {
        // Another write claimed the same value between our check and the commit. Nothing was saved.
        return reply.code(409).send({ message: `${err.column} must be unique; nothing was saved, please retry` });
      }
      throw err;
    }
  });

  app.get<{ Params: { sheet: string; id: string } }>('/api/sheets/:sheet/rows/:id/audit', async (req, reply) => {
    const sheet = getSheet(req.params.sheet);
    if (!sheet) return reply.code(404).send({ message: `Unknown sheet "${req.params.sheet}"` });
    return { entries: await store.listAudit(sheet.key, req.params.id, 200) };
  });

  return app;
}
