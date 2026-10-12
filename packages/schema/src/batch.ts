import { z } from 'zod';
import type { CellValue, Row } from './types.ts';

/** Largest number of row operations accepted in one batch (a 5,000-row paste). */
export const MAX_BATCH_OPS = 5000;

const cellValue = z.union([z.string(), z.number(), z.null()]);
const values = z.record(z.string(), cellValue);

export const batchRequestSchema = z
  .object({
    updates: z
      .array(z.object({ id: z.string().min(1), version: z.number().int().nonnegative(), set: values }))
      .default([]),
    inserts: z.array(z.object({ tempId: z.string().min(1), values })).default([]),
    deletes: z
      .array(z.object({ id: z.string().min(1), version: z.number().int().nonnegative() }))
      .default([]),
  })
  .refine((b) => b.updates.length + b.inserts.length + b.deletes.length <= MAX_BATCH_OPS, {
    message: `At most ${MAX_BATCH_OPS} operations per batch`,
  });

export type BatchRequest = z.input<typeof batchRequestSchema>;
export type ParsedBatchRequest = z.output<typeof batchRequestSchema>;

export type BatchOpKind = 'insert' | 'update' | 'delete';

export interface BatchError {
  op: BatchOpKind;
  /** tempId for inserts, row id for updates and deletes. */
  ref: string;
  column?: string;
  message: string;
}

export interface BatchResponse {
  inserted: { tempId: string; row: Row }[];
  updated: Row[];
  deleted: string[];
  /** Operations rejected by validation. Valid operations in the same batch are still saved. */
  errors: BatchError[];
  /** Rows changed by someone else since they were loaded; `current` is the latest copy (null if deleted). */
  conflicts: { id: string; current: Row | null }[];
}

export interface RowsResponse {
  rows: Row[];
  total: number;
}

export interface AuditEntry {
  id: string;
  sheet: string;
  rowId: string;
  op: BatchOpKind;
  column: string | null;
  oldValue: CellValue;
  newValue: CellValue;
  user: string;
  batchId: string;
  at: string;
}
