import { createValidator } from './utils/validator.js';

import inboxSchema from '../../../schemas/inbox-message.schema.json' with { type: 'json' };

/**
 * Validates an inbox message container against the inbox-message JSON schema.
 *
 * @param data - Data to validate (should be `{ messages: [...] }` container)
 * @returns True if validation passes
 */
export function validateInboxMessage(data: unknown): boolean {
  const validate = createValidator(inboxSchema, 'inbox-message');
  return validate(data) as boolean;
}
