import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { ValidationError } from '../errors.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validatorCache = new Map<string, ValidateFunction>();

/**
 * Creates or retrieves a cached AJV validator for a JSON schema.
 *
 * @param schema - JSON schema object
 * @param schemaId - Unique identifier for caching (typically schema title)
 * @returns Compiled AJV validate function
 */
export function createValidator(schema: object, schemaId: string): ValidateFunction {
  const cached = validatorCache.get(schemaId);
  if (cached) return cached;

  const validate = ajv.compile(schema);
  validatorCache.set(schemaId, validate);
  return validate;
}

/**
 * Validates data against a JSON schema and throws a descriptive error on failure.
 *
 * @param data - Data to validate
 * @param schema - JSON schema object
 * @param schemaId - Identifier for the schema (used for caching and error messages)
 * @throws {ValidationError} If validation fails, with details about which fields failed
 */
export function validateOrThrow(data: unknown, schema: object, schemaId: string): void {
  const validate = createValidator(schema, schemaId);
  if (!validate(data)) {
    const errors = validate.errors ?? [];
    const details = errors.map((e) => ({
      path: e.instancePath || '/',
      message: e.message ?? 'unknown error',
      params: e.params,
    }));
    const paths = details.map((d) => `${d.path}: ${d.message}`).join('; ');
    throw new ValidationError(
      `Validation failed for ${schemaId}: ${paths}`,
      schemaId,
      details,
    );
  }
}
