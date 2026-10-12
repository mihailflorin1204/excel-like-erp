import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env when running from source (Node 22 reads it natively; no dotenv package needed).
// In Docker there is no .env file: settings come from docker-compose.yml.
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const memoryFlag = process.argv.includes('--memory');

export const config = {
  store: memoryFlag ? 'memory' : (process.env.STORE ?? 'mongo'),
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017/erp?replicaSet=rs0&directConnection=true',
  port: Number(process.env.API_PORT ?? 3001),
  /** 127.0.0.1 locally; 0.0.0.0 in a container so other containers can reach it. */
  host: process.env.API_HOST ?? '127.0.0.1',
  /** Add starter rows to empty sheets on startup (always on for the in-memory store). */
  seedOnStart: process.env.SEED_ON_START === 'true',
} as const;
