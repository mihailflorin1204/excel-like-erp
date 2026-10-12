// Writes samples/items-500.tsv: 500 item rows to paste into the Items sheet (the Phase 1 gate).
// Four rows are deliberately wrong so you can see invalid cells turn red while the rest save.
import { mkdirSync, writeFileSync } from 'node:fs';

const units = ['pcs', 'box', 'kg', 'm'];
const cats = ['Fasteners', 'Plumbing', 'Electrical', 'Chemicals', 'Tools'];
const lines = [];
for (let i = 1; i <= 500; i++) {
  const n = String(i).padStart(4, '0');
  lines.push([`TEST-${n}`, `Test item ${n}`, units[i % 4], cats[i % 5], (i * 0.37).toFixed(2), String(i % 40)]);
}
lines[9][2] = 'crate'; // not a unit option
lines[99][4] = 'twelve'; // not a number
lines[199][1] = ''; // name is required
lines[299][0] = 'test-0001'; // duplicate SKU (case-insensitive)

mkdirSync(new URL('../samples/', import.meta.url), { recursive: true });
writeFileSync(new URL('../samples/items-500.tsv', import.meta.url), lines.map((l) => l.join('\t')).join('\n') + '\n');
console.log('Wrote samples/items-500.tsv (500 rows, 4 with errors)');
