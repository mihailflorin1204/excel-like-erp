import { MemoryStore, MongoStore, type SheetStore } from '@erp/db';
import { internalSheets, sheets } from '@erp/schema';
import { config } from './config.ts';

export async function openStore(): Promise<SheetStore> {
  const store: SheetStore = config.store === 'memory' ? new MemoryStore() : new MongoStore(config.mongoUrl);
  await store.init([...sheets, ...internalSheets]);
  return store;
}
