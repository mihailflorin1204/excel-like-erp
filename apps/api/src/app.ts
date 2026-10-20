import { ConflictError, DuplicateKeyError, type SheetStore } from '@erp/db';
import { batchRequestSchema, getSheet, type SheetDef, sheets, usersSheet } from '@erp/schema';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { backfillJournal } from './accounting/backfill.ts';
import {
  type Actor,
  checkPassword,
  clearCookie,
  endSession,
  endSessionsOf,
  passwordProblem,
  readCookie,
  SESSION_COOKIE,
  sessionActor,
  sessionCookie,
  credentialsPlan,
  setPassword,
  signIn,
  startSession,
  systemActor,
  toActor,
} from './auth.ts';
import { runBatch } from './batch.ts';
import { ActionError, applyComputed, hooks } from './hooks.ts';
import { registerViewRoutes } from './views.ts';
import { insertAudit, newRow, postingContext } from './util.ts';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

/**
 * Saves that lose a race (two saves taking the same journal entry number, or bumping the same row, e.g. two
 * stock movements of one item) are rejected by the database and leave nothing behind. Running them again reads
 * the new state, so they either succeed or report a normal validation error.
 */
async function retryOnClash<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      const clash = err instanceof DuplicateKeyError || err instanceof ConflictError;
      if (!clash || attempt >= 4) throw err;
    }
  }
}

export interface AppOptions {
  logger?: boolean;
  /**
   * Require sign-in (default). Off for tests and for trying the app alone; everything then runs as an admin
   * called "local".
   */
  auth?: boolean;
  /** Always mark the session cookie Secure (when TLS ends in front of the app's own proxy). */
  secureCookies?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without signing in (health and the sign-in routes). Every other route requires a session. */
    public?: boolean;
  }
}

const PUBLIC = { config: { public: true } } as const;

const canSee = (actor: Actor, sheet: SheetDef): boolean => !sheet.internal && (!sheet.adminOnly || actor.role === 'Admin');

export function buildApp(store: SheetStore, options: AppOptions = {}): FastifyInstance {
  const auth = options.auth ?? true;
  // A 5,000-row paste is a few MB of JSON.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024, trustProxy: true });
  const secure = (req: FastifyRequest) => !!options.secureCookies || req.protocol === 'https';

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

  // Deny by default: every route needs a signed-in, active user unless it is marked public. Decided on the
  // matched route, never on the URL text (a request line can spell the same route many ways).
  app.decorateRequest('actor', null as unknown as Actor);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.routeOptions.url) return; // no such route: Fastify answers 404
    if (req.routeOptions.config.public) return;
    if (!auth) {
      req.actor = systemActor('local');
      return;
    }
    const actor = await sessionActor(store, readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!actor) return reply.code(401).send({ message: 'Please sign in' });
    if (actor.mustChangePassword) return reply.code(403).send({ message: 'Choose a new password first' });
    req.actor = actor;
  });

  app.get('/api/health', PUBLIC, async () => ({ ok: true }));

  // ---- sign-in ----

  const currentActor = async (req: FastifyRequest) =>
    auth ? sessionActor(store, readCookie(req.headers.cookie, SESSION_COOKIE)) : systemActor('local');

  app.get('/api/auth/me', PUBLIC, async (req, reply) => {
    if (!auth) return { user: systemActor('local'), authEnabled: false };
    if (await store.isEmpty('users')) return { setupNeeded: true, authEnabled: true };
    const actor = await currentActor(req);
    if (!actor) return reply.code(401).send({ message: 'Please sign in', authEnabled: true });
    return { user: actor, authEnabled: true };
  });

  /** First start: whoever opens the app creates the first admin. Refused once any user exists. */
  let settingUp = false;
  app.post<{ Body: { email?: string; name?: string; password?: string } }>('/api/auth/setup', PUBLIC, async (req, reply) => {
    if (!auth) return reply.code(400).send({ message: 'Sign-in is switched off' });
    const { email = '', name = '', password } = req.body ?? {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return reply.code(400).send({ message: 'Enter a valid email' });
    if (!String(name).trim()) return reply.code(400).send({ message: 'Enter your name' });
    const problem = passwordProblem(password);
    if (problem) return reply.code(400).send({ message: problem });
    // One setup at a time (one API process), and the user and their password are saved together.
    if (settingUp) return reply.code(409).send({ message: 'Setup is already running' });
    settingUp = true;
    let user;
    try {
      if (!(await store.isEmpty('users'))) return reply.code(409).send({ message: 'Setup is already done. Please sign in.' });
      const ctx = postingContext(String(email).trim());
      user = newRow(ctx, { email: String(email).trim(), name: String(name).trim(), role: 'Admin', status: 'Active', lastSignIn: ctx.now });
      await store.commit({
        sheet: usersSheet,
        inserts: [user],
        updates: [],
        deletes: [],
        audit: insertAudit(ctx, 'users', user),
        related: [await credentialsPlan(user.id, password!, ctx)],
      });
    } finally {
      settingUp = false;
    }
    const token = await startSession(store, user.id);
    reply.header('set-cookie', sessionCookie(token, secure(req)));
    return { user: toActor(user) };
  });

  app.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', PUBLIC, async (req, reply) => {
    if (!auth) return reply.code(400).send({ message: 'Sign-in is switched off' });
    const { email = '', password = '' } = req.body ?? {};
    const result = await signIn(store, String(email), String(password), req.ip);
    if (!result.ok) return reply.code(result.status).send({ message: result.message });
    reply.header('set-cookie', sessionCookie(result.token, secure(req)));
    return { user: result.actor };
  });

  app.post('/api/auth/logout', PUBLIC, async (req, reply) => {
    await endSession(store, readCookie(req.headers.cookie, SESSION_COOKIE));
    reply.header('set-cookie', clearCookie(secure(req)));
    return { ok: true };
  });

  // Public so a user with a temporary password can reach it; it checks the session itself.
  app.post<{ Body: { current?: string; password?: string } }>('/api/auth/password', PUBLIC, async (req, reply) => {
    if (!auth) return reply.code(400).send({ message: 'Sign-in is switched off' });
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const actor = await sessionActor(store, token);
    if (!actor?.userId) return reply.code(401).send({ message: 'Please sign in' });
    const { current = '', password } = req.body ?? {};
    const check = await checkPassword(store, actor.userId, String(current), req.ip);
    if (check !== 'ok') return reply.code(check === 'locked' ? 429 : 400).send({ message: check === 'locked' ? 'Too many attempts. Try again in 15 minutes.' : 'Your current password is wrong' });
    const problem = passwordProblem(password);
    if (problem) return reply.code(400).send({ message: problem });
    if (password === current) return reply.code(400).send({ message: 'Choose a password different from the current one' });
    await setPassword(store, actor.userId, password!, false, actor.email);
    // Other devices signed in with the old password are signed out.
    await endSessionsOf(store, actor.userId, token);
    return { user: { ...actor, mustChangePassword: false } };
  });

  // ---- sheets ----

  app.get('/api/sheets', async (req) => ({ sheets: sheets.filter((s) => canSee(req.actor, s)) }));

  const sheetFor = (req: FastifyRequest<{ Params: { sheet: string } }>, reply: FastifyReply): SheetDef | null => {
    if (!req.actor) {
      void reply.code(401).send({ message: 'Please sign in' });
      return null;
    }
    const sheet = getSheet(req.params.sheet);
    if (!sheet || sheet.internal) {
      void reply.code(404).send({ message: `Unknown sheet "${req.params.sheet}"` });
      return null;
    }
    if (!canSee(req.actor, sheet)) {
      void reply.code(403).send({ message: `Only an admin can open ${sheet.label}` });
      return null;
    }
    return sheet;
  };

  app.get<{ Params: { sheet: string }; Querystring: Record<string, string | undefined> }>(
    '/api/sheets/:sheet/rows',
    async (req, reply) => {
      const sheet = sheetFor(req, reply);
      if (!sheet) return reply;
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
    const sheet = sheetFor(req, reply);
    if (!sheet) return reply;
    if (sheet.virtual) return reply.code(400).send({ message: `${sheet.label} is a calculated report and can't be edited` });
    const parsed = batchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid batch', issues: parsed.error.issues });
    }
    try {
      return await retryOnClash(() => runBatch(store, sheet, parsed.data, req.actor.email));
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
      const sheet = sheetFor(req, reply);
      if (!sheet) return reply;
      const name = req.params.action;
      const actions = hooks[sheet.key]?.actions;
      // Only actions the sheet declares, looked up as own properties (never e.g. "constructor").
      const declared = sheet.actions?.some((a) => a.key === name) && actions && Object.hasOwn(actions, name);
      const action = declared ? actions[name] : undefined;
      if (!action) return reply.code(404).send({ message: 'Unknown action' });
      try {
        const result = await retryOnClash(() => action(store, req.params.id, req.actor.email));
        const { rows, message } = Array.isArray(result) ? { rows: result, message: undefined } : result;
        return { rows: await applyComputed(store, sheet.key, rows), message };
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
    const sheet = sheetFor(req, reply);
    if (!sheet) return reply;
    return { entries: await store.listAudit(sheet.key, req.params.id, 200) };
  });

  registerViewRoutes(app, store);

  return app;
}
