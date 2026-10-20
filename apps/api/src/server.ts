import { buildApp } from './app.ts';
import { config } from './config.ts';
import { addDemoUser, DEMO_USER, seedIfEmpty } from './seed.ts';
import { openStore } from './store.ts';

const store = await openStore().catch((err: unknown) => {
  console.error(`\nCould not connect to MongoDB at ${config.mongoUrl}`);
  console.error('Start it with "pnpm db:up", or run without a database: "pnpm dev:memory".\n');
  console.error(err);
  process.exit(1);
});

if (config.store === 'memory' || config.seedOnStart) {
  const seeded = await seedIfEmpty(store);
  if (config.store === 'memory') console.log('In-memory store: data resets on restart.');
  if (seeded.length > 0) console.log(`Seeded starter rows: ${seeded.join(', ')}`);
}
if (config.store === 'memory' && config.auth && (await addDemoUser(store))) {
  console.log(`Sign in with ${DEMO_USER.email} / ${DEMO_USER.password} (in-memory demo only).`);
}
if (!config.auth) console.log('Sign-in is switched off (AUTH=off): everyone works as "local".');

const app = buildApp(store, { logger: true, auth: config.auth, secureCookies: config.secureCookies });

const shutdown = async () => {
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
