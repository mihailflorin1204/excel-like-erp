import { config } from './config.ts';
import { seedIfEmpty } from './seed.ts';
import { openStore } from './store.ts';

const store = await openStore();
const seeded = await seedIfEmpty(store);
console.log(seeded.length > 0 ? `Seeded ${seeded.join(', ')} into ${config.store}` : 'Nothing to seed: sheets already have rows.');
await store.close();
