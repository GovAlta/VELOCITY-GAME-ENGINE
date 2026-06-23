import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { AppError } from '../utils/app-error';

/**
 * Zod schema validation middleware factory.
 *
 * Validates request body, query, and/or params against provided Zod schemas.
 * Returns 422 VALIDATION_ERROR with field-level details on failure.
 *
 * @param schema - Object with optional body, query, and params Zod schemas
 */
export function validate(schema: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schema.body) {
        req.body = schema.body.parse(req.body);
      }
      if (schema.query) {
        req.query = schema.query.parse(req.query) as typeof req.query;
      }
      if (schema.params) {
        req.params = schema.params.parse(req.params);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        next(AppError.validation(details));
        return;
      }
      next(error);
    }
  };
}
