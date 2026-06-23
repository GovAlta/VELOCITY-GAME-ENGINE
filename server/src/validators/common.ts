import { z } from 'zod';

/**
 * Shared validator helpers used across all routes.
 *
 * Forms commonly send empty strings (`""`) for unfilled date / numeric fields
 * because that's what HTML inputs default to. Without coercion, an empty string
 * fails a regex like `/^\d{4}-\d{2}-\d{2}$/` and the user sees a confusing
 * "Date must be YYYY-MM-DD" error on a field they intentionally left blank.
 *
 * These helpers normalize empty/whitespace strings to `null` before validation
 * so optional fields actually behave as optional.
 */

export const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const emptyToNull = (v: unknown): unknown =>
  (v === '' || (typeof v === 'string' && v.trim() === '')) ? null : v;

/**
 * Optional `YYYY-MM-DD` date. Accepts `null`, `undefined`, omitted, or empty/
 * whitespace string (all treated as "no value"). Otherwise must match the regex.
 */
export const optionalDate = z.preprocess(
  emptyToNull,
  z.string().regex(dateRegex, 'Date must be YYYY-MM-DD').nullable().optional(),
);

/**
 * Optional integer in [min, max]. Accepts empty string → null.
 */
export const optionalInt = (min?: number, max?: number) => z.preprocess(
  v => (v === '' || v === null || v === undefined) ? null : (typeof v === 'string' ? Number(v) : v),
  z.number().int()
    .refine(n => n === null || min === undefined || n >= min, { message: `Must be ≥ ${min}` })
    .refine(n => n === null || max === undefined || n <= max, { message: `Must be ≤ ${max}` })
    .nullable()
    .optional(),
);

/**
 * Trimmed optional string. Empty → null.
 */
export const optionalString = (maxLength?: number) => z.preprocess(
  emptyToNull,
  maxLength === undefined
    ? z.string().trim().nullable().optional()
    : z.string().trim().max(maxLength).nullable().optional(),
);
