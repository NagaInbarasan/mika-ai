import { GOAL_DEFINITIONS } from './goals.js';
import { evaluateOutcome } from '../evaluation/outcome.js';

/**
 * Diagnostic failure categories for the learning system.
 */
export const FAILURE_CATEGORIES = {
  MISSING_INGREDIENTS: 'MISSING_INGREDIENTS',
  CRAFTING_TABLE_REQUIRED: 'CRAFTING_TABLE_REQUIRED',
  INSUFFICIENT_MATERIALS: 'INSUFFICIENT_MATERIALS',
  OBSTRUCTED_LOCATION: 'OBSTRUCTED_LOCATION',
  THREAT_INTERRUPTED: 'THREAT_INTERRUPTED',
  WRONG_TOOL: 'WRONG_TOOL',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  UNSUITABLE_SITE: 'UNSUITABLE_SITE',
  INCOMPLETE_SHELTER: 'INCOMPLETE_SHELTER',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
};

/**
 * Evaluates an action execution against the active survival goal,
 * determining whether the goal was achieved, classifying failures,
 * and generating corrections.
 *
 * @param {Object} params
 * @param {string} params.goalId - Identifier of current goal
 * @param {Object} params.preObservation - State snapshot before action
 * @param {Object} params.postObservation - State snapshot after action
 * @param {string} params.action - Action name executed
 * @param {Object} [params.args={}] - Action arguments
 * @param {Object} [params.actionResult={}] - Raw result from action execution
 * @param {Object} [params.feedback=null] - Optional human feedback ({ type: 'good'|'bad', message: string })
 * @returns {Object} Comprehensive evaluation result
 */
export function evaluateGoalOutcome({
  goalId,
  preObservation,
  postObservation,
  action,
  args = {},
  actionResult = {},
  feedback = null
}) {
  const goalDef = GOAL_DEFINITIONS[goalId];

  // 1. Calculate physical & inventory deltas using base outcome evaluator
  const baseDelta = evaluateOutcome({
    preObservation,
    postObservation,
    action,
    args,
    executionResult: actionResult
  });

  // 2. Determine goal completion condition
  let goalAchieved = false;
  let completionReason = '';

  if (goalDef && typeof goalDef.isCompleted === 'function') {
    const check = goalDef.isCompleted(postObservation);
    goalAchieved = check.completed;
    completionReason = check.reason;
  } else {
    goalAchieved = actionResult.status === 'success';
    completionReason = actionResult.status === 'success' ? 'Action reported success' : 'No completion validator';
  }

  // 3. Diagnose failure cause and classify category if not achieved
  let failureCategory = null;
  let failureReason = null;
  let recommendedCorrection = null;

  if (!goalAchieved || actionResult.status === 'failed') {
    const errCode = actionResult.error_code || '';
    const errMsg = actionResult.error || '';

    if (errCode === 'MISSING_INGREDIENTS' || errMsg.includes('Missing prerequisite ingredients') || errMsg.includes('Missing ingredients')) {
      failureCategory = FAILURE_CATEGORIES.MISSING_INGREDIENTS;
      failureReason = errMsg || 'Missing ingredients for crafting recipe';
      recommendedCorrection = 'Gather required raw materials or craft intermediate ingredients before retrying';
    } else if (errCode === 'CRAFTING_TABLE_REQUIRED' || errMsg.includes('requires a crafting table') || errMsg.includes('requires a 3x3 Crafting Table')) {
      failureCategory = FAILURE_CATEGORIES.CRAFTING_TABLE_REQUIRED;
      failureReason = 'Crafting table required but not within reach';
      recommendedCorrection = 'Craft and place a crafting table, then stand within 3 blocks';
    } else if (errCode === 'INSUFFICIENT_MATERIALS' || errMsg.includes('Need at least 8 solid building blocks') || errMsg.includes('insufficient')) {
      failureCategory = FAILURE_CATEGORIES.INSUFFICIENT_MATERIALS;
      failureReason = errMsg || 'Not enough building blocks to complete shelter';
      recommendedCorrection = 'Gather at least 8 solid blocks (dirt, cobblestone, or sand) first';
    } else if (errCode === 'UNSUITABLE_SITE' || errMsg.includes('Hazardous block') || errMsg.includes('obstructed')) {
      failureCategory = FAILURE_CATEGORIES.OBSTRUCTED_LOCATION;
      failureReason = errMsg || 'Site is obstructed or unsafe';
      recommendedCorrection = 'Relocate to clear, level ground before building';
    } else if (goalId === 'MINE_STONE' && (postObservation?.inventory || []).filter(i => i.name && i.name.includes('_pickaxe')).length === 0) {
      failureCategory = FAILURE_CATEGORIES.WRONG_TOOL;
      failureReason = 'Attempted to mine stone without a pickaxe (yields 0 drops in Minecraft)';
      recommendedCorrection = 'Craft a wooden pickaxe first before mining stone';
    } else if (baseDelta.damage_taken > 2 || (postObservation?.nearby_threats || []).some(t => t.distance <= 4)) {
      failureCategory = FAILURE_CATEGORIES.THREAT_INTERRUPTED;
      failureReason = `Interrupted by hostile mob during action (took ${baseDelta.damage_taken} damage)`;
      recommendedCorrection = 'Retreat to safety or eliminate immediate threat before resuming task';
    } else if (actionResult.status === 'timeout') {
      failureCategory = FAILURE_CATEGORIES.ACTION_TIMEOUT;
      failureReason = 'Action timed out before achieving goal';
      recommendedCorrection = 'Reduce path distance or break action into smaller steps';
    } else if (goalId === 'BUILD_EMERGENCY_SHELTER' && postObservation?.shelter_safety?.safe === false) {
      failureCategory = FAILURE_CATEGORIES.INCOMPLETE_SHELTER;
      failureReason = postObservation?.shelter_safety?.reason || 'Shelter enclosure incomplete';
      recommendedCorrection = 'Seal ceiling overhead and finish missing walls';
    } else {
      failureCategory = FAILURE_CATEGORIES.UNKNOWN_ERROR;
      failureReason = errMsg || 'Action did not achieve target goal';
      recommendedCorrection = 'Inspect surroundings and re-verify prerequisites';
    }
  }

  // 4. Human feedback integration (!good / !bad)
  let feedbackAdjusted = false;
  let feedbackImpact = 0;

  if (feedback) {
    if (feedback.type === 'good' || feedback.rating > 0) {
      feedbackImpact = +0.5;
      feedbackAdjusted = true;
      // Human confirmed this was good behavior
      if (!goalAchieved && actionResult.status === 'success') {
        goalAchieved = true;
      }
    } else if (feedback.type === 'bad' || feedback.rating < 0) {
      feedbackImpact = -0.5;
      feedbackAdjusted = true;
      goalAchieved = false;
      failureCategory = failureCategory || FAILURE_CATEGORIES.UNKNOWN_ERROR;
      failureReason = `Player marked action as bad: "${feedback.message || 'Disapproved by user'}"`;
      recommendedCorrection = 'Avoid this behavior in similar situations per user guidance';
    }
  }

  const finalScore = Math.max(-1.0, Math.min(1.0, Math.round((baseDelta.reward + feedbackImpact) * 100) / 100));

  return {
    goalId,
    goalAchieved,
    status: goalAchieved ? 'SUCCESS' : (actionResult.status === 'partial' ? 'PARTIAL' : 'FAILED'),
    completionReason,
    failureCategory,
    failureReason,
    recommendedCorrection,
    deltas: {
      healthDelta: baseDelta.health_delta,
      damageTaken: baseDelta.damage_taken,
      foodDelta: baseDelta.food_delta,
      resourceDelta: baseDelta.resource_delta
    },
    feedbackApplied: feedbackAdjusted ? feedback : null,
    evaluationScore: finalScore
  };
}

export default {
  FAILURE_CATEGORIES,
  evaluateGoalOutcome
};
