import { z } from 'zod';
import { ALLOWED_ACTIONS, validateAction } from '../actions/index.js';

export const DecisionSchema = z.object({
  goal: z.string().min(1, 'Goal must not be empty'),
  reason_summary: z.string().min(1, 'Reason summary must be provided'),
  action: z.enum(ALLOWED_ACTIONS, {
    errorMap: () => ({ message: `Action must be one of: ${ALLOWED_ACTIONS.join(', ')}` })
  }),
  arguments: z.record(z.any()).default({}),
  expected_outcome: z.string().min(1, 'Expected outcome must be provided'),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
  confidence: z.number().min(0).max(1).optional().default(0.8)
});

/**
 * Validates raw model output against the structured decision schema and action constraints.
 * @param {Object} rawDecision
 * @returns {{ valid: boolean, decision?: Object, error?: string }}
 */
export function validateDecision(rawDecision) {
  if (!rawDecision || typeof rawDecision !== 'object') {
    return { valid: false, error: 'Model output must be a valid JSON object' };
  }

  const parseResult = DecisionSchema.safeParse(rawDecision);
  if (!parseResult.success) {
    const errorDetails = parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    return {
      valid: false,
      error: `Decision schema validation failed: ${errorDetails}`
    };
  }

  const decision = parseResult.data;

  // Deep validation of arguments against action requirements
  const actionValidation = validateAction(decision.action, decision.arguments);
  if (!actionValidation.valid) {
    return {
      valid: false,
      error: `Invalid action arguments: ${actionValidation.error}`
    };
  }

  return {
    valid: true,
    decision
  };
}

export default DecisionSchema;
