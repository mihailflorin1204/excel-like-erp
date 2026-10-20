import { MemoryStore } from '@erp/db';
import { internalSheets, type Row, sheets } from '@erp/schema';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;
let store: MemoryStore;

type Who = string | undefined;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie?: Who, payload?: unknown) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
const cookieOf = (res: Awaited<ReturnType<typeof call>>) => String(res.headers['set-cookie']).split(';')[0]!;
const rows = async (sheet: string, who: Who) => ((await call('GET', `/api/sheets/${sheet}/rows`, who)).json() as { rows: Row[] }).rows;
const insert = async (sheet: string, who: Who, ...values: Record<string, string | number | null>[]) =>
  (await call('POST', `/api/sheets/${sheet}/batch`, who, { inserts: values.map((v, i) => ({ tempId: `t${i}`, values: v })) })).json();

async function setupAdmin() {
  const res = await call('POST', '/api/auth/setup', undefined, { email: 'ann@example.com', name: 'Ann Admin', password: 'correct horse battery' });
  expect(res.statusCode, res.body).toBe(200);
  return cookieOf(res);
}

/** Creates a member through the Users sheet and signs them in with their own password. */
async function addMember(admin: string, email = 'bob@example.com') {
  const created = await insert('users', admin, { email, name: 'Bob Member', role: 'Member' });
  const id = created.inserted[0].row.id as string;
  const reset = (await call('POST', `/api/sheets/users/rows/${id}/actions/resetPassword`, admin)).json();
  const temp = /: ([a-z0-9-]{14}) /.exec(reset.message)![1]!;
  const login = await call('POST', '/api/auth/login', undefined, { email, password: temp });
  const cookie = cookieOf(login);
  expect(login.json().user.mustChangePassword).toBe(true);
  expect((await call('POST', '/api/auth/password', cookie, { current: temp, password: 'bobs own password' })).statusCode).toBe(200);
  return { id, cookie };
}

beforeEach(async () => {
  store = new MemoryStore();
  await store.init([...sheets, ...internalSheets]);
  app = buildApp(store);
});

describe('first start and sign-in', () => {
  it('asks for setup until the first admin exists, then only once', async () => {
    expect((await call('GET', '/api/auth/me')).json()).toEqual({ setupNeeded: true, authEnabled: true });
    expect((await call('GET', '/api/sheets')).statusCode).toBe(401);
    const weak = await call('POST', '/api/auth/setup', undefined, { email: 'ann@example.com', name: 'Ann', password: 'short' });
    expect(weak.json().message).toBe('Use at least 10 characters');

    const admin = await setupAdmin();
    expect(admin).toMatch(/^erp_session=/);
    expect((await call('GET', '/api/auth/me', admin)).json().user).toMatchObject({ email: 'ann@example.com', role: 'Admin' });
    const again = await call('POST', '/api/auth/setup', undefined, { email: 'eve@example.com', name: 'Eve', password: 'correct horse battery' });
    expect(again.statusCode).toBe(409);
    expect((await call('GET', '/api/sheets', admin)).statusCode).toBe(200);
  });

  it('signs in and out; wrong passwords are refused and slowed down', async () => {
    await setupAdmin();
    expect((await call('POST', '/api/auth/login', undefined, { email: 'ann@example.com', password: 'nope' })).statusCode).toBe(401);
    const ok = await call('POST', '/api/auth/login', undefined, { email: 'ANN@example.com', password: 'correct horse battery' });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieOf(ok);
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await call('GET', '/api/sheets', cookie)).statusCode).toBe(200);
    await call('POST', '/api/auth/logout', cookie);
    expect((await call('GET', '/api/sheets', cookie)).statusCode).toBe(401);

    for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', undefined, { email: 'ann@example.com', password: 'wrong' });
    const locked = await call('POST', '/api/auth/login', undefined, { email: 'ann@example.com', password: 'correct horse battery' });
    expect(locked.statusCode).toBe(429);
  });

  it('never exposes password hashes or sessions through the sheet routes', async () => {
    const admin = await setupAdmin();
    for (const sheet of ['credentials', 'sessions', 'views', 'stockGuards']) {
      expect((await call('GET', `/api/sheets/${sheet}/rows`, admin)).statusCode).toBe(404);
    }
    const users = await rows('users', admin);
    expect(users[0]!.values).toMatchObject({ email: 'ann@example.com', hasPassword: 'Set' });
    expect(JSON.stringify(users)).not.toMatch(/scrypt/);
  });

  it('records who changed what in the audit log', async () => {
    const admin = await setupAdmin();
    const res = await insert('warehouses', admin, { code: 'MAIN', name: 'Main' });
    const audit = (await call('GET', `/api/sheets/warehouses/rows/${res.inserted[0].row.id}/audit`, admin)).json();
    expect(audit.entries[0].user).toBe('ann@example.com');
  });
});

describe('users and permissions', () => {
  it('a new user signs in with a temporary password and must choose their own first', async () => {
    const admin = await setupAdmin();
    const created = await insert('users', admin, { email: 'bob@example.com', name: 'Bob', role: 'Member' });
    expect(created.inserted[0].row.values).toMatchObject({ status: 'Active', hasPassword: 'Not set' });
    const id = created.inserted[0].row.id;
    const reset = (await call('POST', `/api/sheets/users/rows/${id}/actions/resetPassword`, admin)).json();
    expect(reset.message).toMatch(/^Temporary password for bob@example.com: [a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4} \(shown only now\)/);
    expect(reset.rows[0].values.hasPassword).toBe('Temporary');
    const temp = /: ([a-z0-9-]{14}) /.exec(reset.message)![1]!;

    const login = await call('POST', '/api/auth/login', undefined, { email: 'bob@example.com', password: temp });
    const bob = cookieOf(login);
    expect((await call('GET', '/api/sheets', bob)).json().message).toBe('Choose a new password first');
    expect((await call('POST', '/api/auth/password', bob, { current: 'wrong', password: 'bobs own password' })).json().message).toBe('Your current password is wrong');
    expect((await call('POST', '/api/auth/password', bob, { current: temp, password: temp })).statusCode).toBe(400);
    expect((await call('POST', '/api/auth/password', bob, { current: temp, password: 'bobs own password' })).statusCode).toBe(200);
    expect((await call('GET', '/api/sheets', bob)).statusCode).toBe(200);
  });

  it('members don\'t see or change users', async () => {
    const admin = await setupAdmin();
    const { cookie: bob } = await addMember(admin);
    const sheetKeys = (await call('GET', '/api/sheets', bob)).json().sheets.map((s: { key: string }) => s.key);
    expect(sheetKeys).not.toContain('users');
    expect((await call('GET', '/api/sheets', admin)).json().sheets.map((s: { key: string }) => s.key)).toContain('users');
    expect((await call('GET', '/api/sheets/users/rows', bob)).statusCode).toBe(403);
    expect((await call('POST', '/api/sheets/users/batch', bob, { inserts: [{ tempId: 'x', values: { email: 'eve@example.com', name: 'Eve', role: 'Admin' } }] })).statusCode).toBe(403);
  });

  it("admins can't lock themselves out, the last admin stays, and users are disabled rather than deleted", async () => {
    const admin = await setupAdmin();
    const [ann] = await rows('users', admin);
    const self = (await call('POST', '/api/sheets/users/batch', admin, { updates: [{ id: ann!.id, version: ann!.version, set: { role: 'Member', status: 'Disabled' } }] })).json();
    expect(self.errors.map((e: { message: string }) => e.message)).toEqual([
      "You can't change your own role; ask another admin",
      "You can't disable your own account",
    ]);
    // Someone else (here: sign-in switched off) still can't remove the last active admin.
    const open = buildApp(store, { auth: false });
    const demote = (await open.inject({ method: 'POST', url: '/api/sheets/users/batch', payload: { updates: [{ id: ann!.id, version: ann!.version, set: { role: 'Member' } }] } })).json();
    expect(demote.errors.map((e: { message: string }) => e.message)).toEqual(['At least one active admin must remain']);
    const del = (await call('POST', '/api/sheets/users/batch', admin, { deletes: [{ id: ann!.id, version: ann!.version }] })).json();
    expect(del.errors[0].message).toBe('Users are not deleted: set Status to Disabled instead');
  });

  it('a disabled user is signed out at once', async () => {
    const admin = await setupAdmin();
    const { id, cookie: bob } = await addMember(admin);
    const [user] = (await rows('users', admin)).filter((u) => u.id === id);
    await call('POST', '/api/sheets/users/batch', admin, { updates: [{ id, version: user!.version, set: { status: 'Disabled' } }] });
    expect((await call('GET', '/api/sheets', bob)).statusCode).toBe(401);
    const login = await call('POST', '/api/auth/login', undefined, { email: 'bob@example.com', password: 'bobs own password' });
    expect(login.json().message).toBe('This account is disabled. Ask an admin.');
  });
});

describe('saved views', () => {
  const config = { query: 'BOLT', sort: { column: 'sku', dir: 'desc' }, hidden: ['category'], frozen: 2, formulas: [{ key: 'f1', label: 'Value', formula: '=[On hand]*[Cost]' }] };

  it('are private unless shared; only the owner changes one; owner or admin deletes', async () => {
    const admin = await setupAdmin();
    const { cookie: bob } = await addMember(admin);
    const mine = (await call('POST', '/api/views', bob, { sheet: 'items', name: 'Bolts', config })).json().view;
    expect(mine).toMatchObject({ name: 'Bolts', owner: 'bob@example.com', shared: false, mine: true, config });
    expect((await call('GET', '/api/views?sheet=items', admin)).json().views).toEqual([]);

    await call('PUT', `/api/views/${mine.id}`, bob, { shared: true });
    const seen = (await call('GET', '/api/views?sheet=items', admin)).json().views;
    expect(seen).toMatchObject([{ name: 'Bolts', shared: true, mine: false }]);
    expect((await call('PUT', `/api/views/${mine.id}`, admin, { name: 'Mine now' })).statusCode).toBe(403);
    expect((await call('DELETE', `/api/views/${mine.id}`, admin)).statusCode).toBe(200);
    expect((await call('GET', '/api/views?sheet=items', bob)).json().views).toEqual([]);
  });

  it('checks what is saved', async () => {
    const admin = await setupAdmin();
    expect((await call('POST', '/api/views', admin, { sheet: 'items', name: '', config })).statusCode).toBe(400);
    expect((await call('POST', '/api/views', admin, { sheet: 'credentials', name: 'x', config })).statusCode).toBe(404);
    expect((await call('POST', '/api/views', admin, { sheet: 'items', name: 'x', config: { ...config, frozen: 99 } })).statusCode).toBe(400);
    expect((await call('GET', '/api/views?sheet=items')).statusCode).toBe(401);
  });
});

describe('sign-in switched off', () => {
  it('works as before, as an admin called local', async () => {
    const open = buildApp(store, { auth: false });
    const me = (await open.inject({ method: 'GET', url: '/api/auth/me' })).json();
    expect(me).toMatchObject({ authEnabled: false, user: { email: 'local', role: 'Admin' } });
    expect((await open.inject({ method: 'GET', url: '/api/sheets/users/rows' })).statusCode).toBe(200);
  });
});

describe('review fixes', () => {
  it('a full URL in the request line does not get around sign-in', async () => {
    await setupAdmin();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as import('node:net').AddressInfo;
    const net = await import('node:net');
    const raw = (path: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let data = '';
        socket.on('data', (d) => (data += d));
        socket.on('end', () => resolve(data.split('\r\n')[0]!));
        socket.on('error', reject);
      });
    expect(await raw('http://x/api/sheets/items/rows')).toMatch(/ 401 /);
    expect(await raw('/api/sheets/items/rows?x=/api/auth/')).toMatch(/ 401 /);
    expect(await raw('/api/auth/../sheets/items/rows')).toMatch(/ 40[14] /);
    expect(await raw('/api/health')).toMatch(/ 200 /);
    await app.close();
  });

  it('parallel password guesses still hit the limit', async () => {
    await setupAdmin();
    const res = await Promise.all(
      Array.from({ length: 20 }, () => call('POST', '/api/auth/login', undefined, { email: 'ann@example.com', password: 'wrong guess' })),
    );
    expect(res.filter((r) => r.statusCode === 401).length).toBeLessThanOrEqual(5);
    expect(res.filter((r) => r.statusCode === 429).length).toBeGreaterThanOrEqual(15);
  });

  it('password changes never put a hash in the audit log', async () => {
    const admin = await setupAdmin();
    await addMember(admin);
    const creds = await store.listWhere('credentials', 'user');
    for (const c of creds) {
      const audit = await store.listAudit('credentials', c.id, 50);
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toMatch(/scrypt/);
    }
  });

  it('disabling a user ends their sessions for good; re-enabling needs a new sign-in', async () => {
    const admin = await setupAdmin();
    const { id, cookie: bob } = await addMember(admin);
    let [user] = (await rows('users', admin)).filter((u) => u.id === id);
    await call('POST', '/api/sheets/users/batch', admin, { updates: [{ id, version: user!.version, set: { status: 'Disabled' } }] });
    [user] = (await rows('users', admin)).filter((u) => u.id === id);
    await call('POST', '/api/sheets/users/batch', admin, { updates: [{ id, version: user!.version, set: { status: 'Active' } }] });
    expect((await call('GET', '/api/sheets', bob)).statusCode).toBe(401);
  });

  it("admins can't change their own email; members can't keep views of admin-only sheets; formula keys are unique", async () => {
    const admin = await setupAdmin();
    const [ann] = await rows('users', admin);
    const res = (await call('POST', '/api/sheets/users/batch', admin, { updates: [{ id: ann!.id, version: ann!.version, set: { email: 'other@example.com' } }] })).json();
    expect(res.errors[0].message).toBe("You can't change your own email; ask another admin");
    const { cookie: bob } = await addMember(admin);
    const config = { query: '', sort: null, hidden: [], frozen: 1, formulas: [] };
    expect((await call('POST', '/api/views', bob, { sheet: 'users', name: 'x', config })).statusCode).toBe(404);
    const dup = { ...config, formulas: [{ key: 'f1', label: 'a', formula: '=1' }, { key: 'f1', label: 'b', formula: '=2' }] };
    expect((await call('POST', '/api/views', bob, { sheet: 'items', name: 'x', config: dup })).statusCode).toBe(400);
  });
});
