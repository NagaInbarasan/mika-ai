/**
 * Detects and classifies mistakes from observable execution and outcome evidence.
 *
 * @param {Object} params
 * @param {string} params.action - Executed action
 * @param {Object} [params.args={}] - Arguments
 * @param {Object} params.execution - Execution status and error
 * @param {Object} params.outcome - Evaluated outcome deltas
 * @param {Object} [params.observationBefore] - Pre-action snapshot
 * @param {Object} [params.observationAfter] - Post-action snapshot
 * @returns {Object} Mistake diagnosis
 */
export function detectMistake({ action, args = {}, execution = {}, outcome = {}, observationBefore = {}, observationAfter = {} }) {
  const isFailed = execution.status === 'failed' || execution.status === 'timeout';
  const outcomeUnmet = outcome && outcome.predicted_outcome_met === false;
  const damageTaken = outcome && outcome.damage_taken > 0;
  const botDied = observationAfter.agent && observationAfter.agent.isAlive === false;

  if (!isFailed && !outcomeUnmet && !damageTaken && !botDied) {
    return {
      failure_detected: false,
      failure_category: null,
      observed_evidence: null,
      situation_pattern: null
    };
  }

  let category = 'unknown';
  let evidence = execution.error || 'Action failed to produce expected outcome';
  let situationPattern = `${action}`;

  const errorCode = execution.error_code || '';

  // 1. Missing Prerequisites
  if (['MISSING_INGREDIENTS', 'CRAFTING_TABLE_REQUIRED', 'NO_FOOD_AVAILABLE', 'FOOD_NOT_IN_INVENTORY'].includes(errorCode)) {
    category = 'missing_prerequisite';
    const itemTarget = args.item || args.food_name || 'item';
    situationPattern = `${action}:${itemTarget}:missing_prerequisite`;
    evidence = execution.error || `Preconditions missing for ${action} ${itemTarget}`;
  } 
  // 2. Resource Planning & Discovery
  else if (['RESOURCE_NOT_FOUND', 'BLOCK_NOT_HARVESTABLE'].includes(errorCode)) {
    category = 'resource_planning';
    const resTarget = args.resource || 'block';
    situationPattern = `collect:${resTarget}:not_found`;
    evidence = `Resource '${resTarget}' could not be located or harvested in current area`;
  }
  // 3. Navigation Failures
  else if (['UNREACHABLE_TARGET', 'PATHFINDER_START_ERROR', 'NAVIGATION_TIMEOUT'].includes(errorCode) || (action === 'navigate_to' && isFailed)) {
    category = 'navigation';
    situationPattern = `navigate:unreachable`;
    evidence = execution.error || 'Pathfinding failed or target was unreachable';
  }
  // 4. Timeouts
  else if (execution.status === 'timeout' || errorCode.includes('TIMEOUT')) {
    category = 'timeout';
    situationPattern = `${action}:timeout`;
    evidence = execution.error || `Action '${action}' exceeded execution timeout budget`;
  }
  // 5. Threat Response (damage taken, death)
  else if (botDied || (damageTaken && outcome.damage_taken >= 4)) {
    category = 'threat_response';
    const threatName = observationBefore.nearby_threats?.[0]?.name || 'hostile_mob';
    situationPattern = `threat:${threatName}:damage`;
    evidence = botDied ? 'Bot took fatal damage' : `Bot sustained ${outcome.damage_taken} damage from nearby hazards`;
  }
  // 6. Invalid Action Proposals
  else if (errorCode === 'INVALID_ACTION' || errorCode === 'INVALID_ARGUMENTS') {
    category = 'invalid_action';
    situationPattern = `${action}:invalid_arguments`;
    evidence = execution.error || 'Invalid action parameters proposed';
  }
  // 7. Prediction Mismatch (action returned success, but inventory/world didn't change)
  else if (execution.status === 'success' && outcomeUnmet) {
    category = 'model_prediction_error';
    situationPattern = `${action}:prediction_unmet`;
    evidence = `Execution completed without error, but world outcome did not meet expected criteria`;
  }

  return {
    failure_detected: true,
    failure_category: category,
    error_code: errorCode,
    observed_evidence: evidence,
    situation_pattern: situationPattern,
    attempted_action: action,
    attempted_arguments: args
  };
}

export default detectMistake;
