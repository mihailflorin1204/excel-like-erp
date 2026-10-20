import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { CommitPlan, SheetStore } from '@erp/db';
import { credentialsSheet, type Row, sessionsSheet, uniqueKey, usersSheet } from '@erp/schema';
import { ActionError } from './hooks.ts';
import { auditEntry, newRow, type PostingContext, postingContext, str } from './util.ts';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

export const MIN_PASSWORD_LENGTH = 10;
export const SESSION_COOKIE = 'erp_session';
export const SESSION_DAYS = 14;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export interface Actor {
  email: string;
  name: string;
  role: 'Admin' | 'Member';
  userId: string | null;
  mustChangePassword: boolean;
}

/** Names used when there is no signed-in person: auth switched off, seeding, the startup backfill. */
const SYSTEM_USERS = new Set(['local', 'seed', 'system']);
export const systemActor = (name: string): Actor => ({ email: name, name, role: 'Admin', userId: null, mustChangePassword: false });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 200) return 'Use at most 200 characters';
  return null;
}

/** Easy to read out and type: no 0/O or 1/l/I. */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const part = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${part()}-${part()}-${part()}`;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export const findUser = async (store: SheetStore, email: string): Promise<Row | undefined> =>
  (await store.findByUnique('users', 'email', [uniqueKey(email.trim())!]))[0];

async function credentialsOf(store: SheetStore, userId: string): Promise<Row | undefined> {
  return (await store.listWhere(credentialsSheet.key, 'user', [userId]))[0];
}

export const toActor = (user: Row, mustChange = false): Actor => ({
  email: String(user.values.email),
  name: String(user.values.name ?? user.values.email),
  role: user.values.role === 'Admin' ? 'Admin' : 'Member',
  userId: user.id,
  mustChangePassword: mustChange,
});

const isActive = (user: Row) => (str(user.values.status) ?? 'Active') === 'Active';

/** Who a user name in an action or hook stands for (an email, or a system name such as "seed"). */
export async function actorOf(store: SheetStore, user: string): Promise<Actor> {
  if (SYSTEM_USERS.has(user)) return systemActor(user);
  const row = await findUser(store, user);
  if (!row || !isActive(row)) return { ...systemActor(user), role: 'Member' };
  return toActor(row);
}

export async function requireAdmin(store: SheetStore, user: string, what: string): Promise<Actor> {
  const actor = await actorOf(store, user);
  if (actor.role !== 'Admin') throw new ActionError(403, `Only an admin can ${what}`);
  return actor;
}

/** Password audit entries: that it changed, never a hash (old or new). */
const passwordAudit = (ctx: PostingContext, rowId: string, op: 'insert' | 'update', mustChange: string | null) => [
  auditEntry(ctx, credentialsSheet.key, rowId, op, 'hash', op === 'update' ? '(hidden)' : null, '(hidden)'),
  auditEntry(ctx, credentialsSheet.key, rowId, op, 'mustChange', null, mustChange),
];

/** A new credentials row for a user (saved by the caller, e.g. together with the user at first setup). */
export async function credentialsPlan(userId: string, password: string, ctx: PostingContext): Promise<CommitPlan> {
  const row = newRow(ctx, { user: userId, hash: await hashPassword(password), mustChange: null });
  return { sheet: credentialsSheet, inserts: [row], updates: [], deletes: [], audit: passwordAudit(ctx, row.id, 'insert', null) };
}

/** Sets (or replaces) a user's password. `mustChange` makes them pick a new one at next sign-in. */
export async function setPassword(store: SheetStore, userId: string, password: string, mustChange: boolean, by: string): Promise<void> {
  const ctx = postingContext(by);
  const hash = await hashPassword(password);
  const existing = await credentialsOf(store, userId);
  const values = { user: userId, hash, mustChange: mustChange ? 'yes' : null };
  if (existing) {
    await store.commit({
      sheet: credentialsSheet,
      inserts: [],
      updates: [{ id: existing.id, expectedVersion: existing.version, set: values, updatedAt: ctx.now }],
      deletes: [],
      audit: passwordAudit(ctx, existing.id, 'update', values.mustChange),
      atomic: true,
    });
  } else {
    const row = newRow(ctx, values);
    await store.commit({ sheet: credentialsSheet, inserts: [row], updates: [], deletes: [], audit: passwordAudit(ctx, row.id, 'insert', values.mustChange) });
  }
}

export async function hasPassword(store: SheetStore, userIds: readonly string[]): Promise<Map<string, 'Set' | 'Temporary'>> {
  const rows = userIds.length ? await store.listWhere(credentialsSheet.key, 'user', userIds) : [];
  return new Map(rows.map((r) => [String(r.values.user), r.values.mustChange ? 'Temporary' : 'Set']));
}

/**
 * Failed attempts, to slow down password guessing: per email and address (5), and per address (50), for
 * 15 minutes. Counted before the (slow) password check, so parallel guesses count too. Kept in memory: it
 * resets when the API restarts.
 */
const attempts = new Map<string, { count: number; until: number }>();
const LOCK_MS = 15 * 60_000;
const isLocked = (key: string, max: number) => {
  const a = attempts.get(key);
  return !!a && a.until > Date.now() && a.count >= max;
};
function noteAttempt(key: string) {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, a] of attempts) if (a.until <= now) attempts.delete(k);
  const a = attempts.get(key);
  attempts.set(key, { count: (a && a.until > now ? a.count : 0) + 1, until: now + LOCK_MS });
}

/** Unknown emails still pay for one hash check, so the response time doesn't tell which emails exist. */
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));

export type SignInResult = { ok: true; actor: Actor; token: string } | { ok: false; status: number; message: string };
const TOO_MANY = { ok: false as const, status: 429, message: 'Too many attempts. Try again in 15 minutes.' };

export async function signIn(store: SheetStore, email: string, password: string, ip = 'local'): Promise<SignInResult> {
  const userKey = `login:${uniqueKey(email.trim()) ?? ''}|${ip}`;
  const ipKey = `ip:${ip}`;
  if (isLocked(userKey, 5) || isLocked(ipKey, 50)) return TOO_MANY;
  noteAttempt(userKey);
  noteAttempt(ipKey);
  const user = await findUser(store, email);
  const creds = user ? await credentialsOf(store, user.id) : undefined;
  const valid = await verifyPassword(password, creds ? String(creds.values.hash) : await dummy());
  if (!valid || !user || !creds) return { ok: false, status: 401, message: 'Wrong email or password' };
  attempts.delete(userKey);
  if (!isActive(user)) return { ok: false, status: 403, message: 'This account is disabled. Ask an admin.' };
  const token = await startSession(store, user.id);
  const ctx = postingContext(String(user.values.email));
  await store.commit({
    sheet: usersSheet,
    inserts: [],
    updates: [{ id: user.id, expectedVersion: user.version, set: { lastSignIn: new Date().toISOString() }, updatedAt: ctx.now }],
    deletes: [],
    audit: [],
  });
  return { ok: true, actor: toActor(user, !!creds.values.mustChange), token };
}

export async function startSession(store: SheetStore, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const ctx = postingContext('system');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await store.commit({
    sheet: sessionsSheet,
    inserts: [newRow(ctx, { tokenHash: tokenHash(token), user: userId, expiresAt })],
    updates: [],
    deletes: [],
    audit: [],
  });
  return token;
}

/** The signed-in person for a session token, or null (unknown, expired, or the user was disabled). */
export async function sessionActor(store: SheetStore, token: string | undefined): Promise<Actor | null> {
  if (!token) return null;
  const [session] = await store.findByUnique(sessionsSheet.key, 'tokenHash', [tokenHash(token)]);
  if (!session || String(session.values.expiresAt) < new Date().toISOString()) return null;
  const [user] = await store.getRows('users', [String(session.values.user)]);
  if (!user || !isActive(user)) return null;
  const creds = await credentialsOf(store, user.id);
  return toActor(user, !!creds?.values.mustChange);
}

export async function endSession(store: SheetStore, token: string | undefined): Promise<void> {
  if (!token) return;
  const rows = await store.findByUnique(sessionsSheet.key, 'tokenHash', [tokenHash(token)]);
  if (rows.length === 0) return;
  await store.commit({ sheet: sessionsSheet, inserts: [], updates: [], deletes: rows.map((r) => ({ id: r.id, expectedVersion: r.version })), audit: [] });
}

/** Signs a user out everywhere (after a password reset), except the session `keep` if given. */
export async function endSessionsOf(store: SheetStore, userId: string, keep?: string): Promise<void> {
  const keepHash = keep ? tokenHash(keep) : null;
  const rows = (await store.listWhere(sessionsSheet.key, 'user', [userId])).filter((r) => r.values.tokenHash !== keepHash);
  if (rows.length === 0) return;
  await store.commit({ sheet: sessionsSheet, inserts: [], updates: [], deletes: rows.map((r) => ({ id: r.id, expectedVersion: r.version })), audit: [] });
}

/** Checks a signed-in user's current password (before changing it), with the same attempt limit as sign-in. */
export async function checkPassword(store: SheetStore, userId: string, password: string, ip = 'local'): Promise<'ok' | 'wrong' | 'locked'> {
  const key = `password:${userId}`;
  if (isLocked(key, 5) || isLocked(`ip:${ip}`, 50)) return 'locked';
  noteAttempt(key);
  const creds = await credentialsOf(store, userId);
  if (!creds || !(await verifyPassword(password, String(creds.values.hash)))) return 'wrong';
  attempts.delete(key);
  return 'ok';
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
}

export const clearCookie = (secure: boolean) => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
