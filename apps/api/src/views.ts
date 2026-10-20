import type { SheetStore } from '@erp/db';
import { getSheet, type Row, type SavedView, viewConfigSchema, viewsSheet, z } from '@erp/schema';
import type { FastifyInstance } from 'fastify';
import { auditEntry, insertAudit, newRow, postingContext, updateAudit } from './util.ts';

const viewBody = z.object({
  sheet: z.string(),
  name: z.string().trim().min(1).max(60),
  shared: z.boolean().default(false),
  config: viewConfigSchema,
});
const viewPatch = viewBody.omit({ sheet: true }).partial();

const MAX_VIEWS_PER_USER = 100;

const toView = (r: Row, me: string): SavedView => ({
  id: r.id,
  version: r.version,
  sheet: String(r.values.sheet),
  name: String(r.values.name),
  owner: String(r.values.owner),
  shared: r.values.shared === 'yes',
  mine: String(r.values.owner).toLowerCase() === me.toLowerCase(),
  config: parseConfig(r.values.config),
});

/** A stored config that no longer parses (e.g. after an upgrade) opens as the standard view instead of failing. */
function parseConfig(raw: unknown) {
  try {
    const parsed = viewConfigSchema.safeParse(JSON.parse(String(raw ?? '{}')));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  return viewConfigSchema.parse({});
}

/**
 * Saved views per sheet: everyone sees their own views and the shared ones. Only the owner changes a view;
 * the owner or an admin deletes it.
 */
export function registerViewRoutes(app: FastifyInstance, store: SheetStore): void {
  const visible = (r: Row, me: string) => r.values.shared === 'yes' || String(r.values.owner).toLowerCase() === me.toLowerCase();

  /** Views belong to a sheet the person may open (members can't keep views of admin-only sheets). */
  const allowed = (sheetKey: string, role: string) => {
    const def = getSheet(sheetKey);
    return !!def && !def.internal && (!def.adminOnly || role === 'Admin');
  };

  app.get<{ Querystring: { sheet?: string } }>('/api/views', async (req) => {
    if (!allowed(String(req.query.sheet ?? ''), req.actor.role)) return { views: [] };
    const rows = await store.listWhere(viewsSheet.key, 'sheet', [String(req.query.sheet ?? '')]);
    return {
      views: rows
        .filter((r) => visible(r, req.actor.email))
        .map((r) => toView(r, req.actor.email))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  app.post('/api/views', async (req, reply) => {
    const parsed = viewBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid view', issues: parsed.error.issues });
    const { sheet, name, shared, config } = parsed.data;
    if (!allowed(sheet, req.actor.role)) return reply.code(404).send({ message: `Unknown sheet "${sheet}"` });
    const mine = (await store.listWhere(viewsSheet.key, 'owner', [req.actor.email])).length;
    if (mine >= MAX_VIEWS_PER_USER) return reply.code(409).send({ message: `You already have ${MAX_VIEWS_PER_USER} saved views; delete some first` });
    const ctx = postingContext(req.actor.email);
    const row = newRow(ctx, { sheet, name, owner: req.actor.email, shared: shared ? 'yes' : null, config: JSON.stringify(config) });
    await store.commit({ sheet: viewsSheet, inserts: [row], updates: [], deletes: [], audit: insertAudit(ctx, viewsSheet.key, row) });
    return { view: toView(row, req.actor.email) };
  });

  app.put<{ Params: { id: string } }>('/api/views/:id', async (req, reply) => {
    const parsed = viewPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid view', issues: parsed.error.issues });
    const [row] = await store.getRows(viewsSheet.key, [req.params.id]);
    if (!row || !visible(row, req.actor.email)) return reply.code(404).send({ message: 'View not found' });
    if (!toView(row, req.actor.email).mine) return reply.code(403).send({ message: 'Only its owner can change this view. Use Save as to keep your own copy.' });
    const set: Record<string, string | null> = {};
    if (parsed.data.name !== undefined) set.name = parsed.data.name;
    if (parsed.data.shared !== undefined) set.shared = parsed.data.shared ? 'yes' : null;
    if (parsed.data.config !== undefined) set.config = JSON.stringify(parsed.data.config);
    const ctx = postingContext(req.actor.email);
    const { conflictIds } = await store.commit({
      sheet: viewsSheet,
      inserts: [],
      updates: [{ id: row.id, expectedVersion: row.version, set, updatedAt: ctx.now }],
      deletes: [],
      audit: updateAudit(ctx, viewsSheet.key, row, set),
    });
    if (conflictIds.length > 0) return reply.code(409).send({ message: 'The view was just changed elsewhere; reload and try again' });
    return { view: toView({ ...row, version: row.version + 1, values: { ...row.values, ...set } }, req.actor.email) };
  });

  app.delete<{ Params: { id: string } }>('/api/views/:id', async (req, reply) => {
    const [row] = await store.getRows(viewsSheet.key, [req.params.id]);
    if (!row || !visible(row, req.actor.email)) return reply.code(404).send({ message: 'View not found' });
    if (!toView(row, req.actor.email).mine && req.actor.role !== 'Admin') return reply.code(403).send({ message: 'Only its owner or an admin can delete this view' });
    const ctx = postingContext(req.actor.email);
    await store.commit({
      sheet: viewsSheet,
      inserts: [],
      updates: [],
      deletes: [{ id: row.id, expectedVersion: row.version }],
      audit: [auditEntry(ctx, viewsSheet.key, row.id, 'delete', null, String(row.values.name), null)],
    });
    return { ok: true };
  });
}
