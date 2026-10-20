import { z } from 'zod';

export { z };

/** What a saved view remembers about a grid. Formula columns live only here, never in ERP data. */
export const viewConfigSchema = z.object({
  query: z.string().max(500).default(''),
  sort: z.object({ column: z.string().max(100), dir: z.enum(['asc', 'desc']) }).nullable().default(null),
  hidden: z.array(z.string().max(100)).max(200).default([]),
  frozen: z.number().int().min(0).max(10).default(1),
  formulas: z
    .array(z.object({ key: z.string().regex(/^f\d{1,4}$/), label: z.string().min(1).max(60), formula: z.string().min(1).max(2000) }))
    .max(30)
    .default([])
    .refine((f) => new Set(f.map((x) => x.key)).size === f.length, { message: 'Formula columns need different keys' }),
});
export type ViewConfig = z.output<typeof viewConfigSchema>;

export interface SavedView {
  id: string;
  version: number;
  sheet: string;
  name: string;
  owner: string;
  shared: boolean;
  /** Saved by the person asking (only they can change it). */
  mine: boolean;
  config: ViewConfig;
}
