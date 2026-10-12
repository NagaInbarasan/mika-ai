/**
 * Calculates measurable deltas and evaluates actual world outcome between pre and post observations.
 * Distinguishes missing data (null) from zero (0).
 *
 * @param {Object} params
 * @param {Object} params.preObservation - State before action
 * @param {Object} params.postObservation - State after action
 * @param {string} params.action - Action name
 * @param {Object} params.args - Action arguments
 * @param {string} [params.expectedOutcome] - Textual expectation
 * @param {Object} params.executionResult - Execution status, duration, error
 * @returns {Object} Measured outcome record
 */
export function evaluateOutcome({ preObservation, postObservation, action, args = {}, expectedOutcome = null, executionResult = {} }) {
  if (!preObservation || !postObservation || !preObservation.agent || !postObservation.agent) {
    return {
      status: executionResult.status || 'failed',
      duration_ms: executionResult.duration_ms || 0,
      predicted_outcome_met: false,
      task_progress: 0,
      reward: -0.1,
      error: 'Missing valid pre or post observations'
    };
  }

  const preAgent = preObservation.agent;
  const postAgent = postObservation.agent;

  // 1. Position & Navigation Deltas
  let positionDelta = null;
  let distanceMoved = 0;
  let targetReached = null;
  let distanceToTarget = null;

  if (preAgent.position && postAgent.position) {
    const dx = Math.round((postAgent.position.x - preAgent.position.x) * 10) / 10;
    const dy = Math.round((postAgent.position.y - preAgent.position.y) * 10) / 10;
    const dz = Math.round((postAgent.position.z - preAgent.position.z) * 10) / 10;
    distanceMoved = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10;
    positionDelta = { dx, dy, dz, distance_moved: distanceMoved };

    if (action === 'navigate_to' && args.x !== undefined && args.z !== undefined) {
      const targetY = args.y !== undefined ? args.y : postAgent.position.y;
      const tdx = postAgent.position.x - args.x;
      const tdy = postAgent.position.y - targetY;
      const tdz = postAgent.position.z - args.z;
      distanceToTarget = Math.round(Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz) * 10) / 10;
      const tolerance = args.range !== undefined ? args.range : 1.5;
      targetReached = distanceToTarget <= tolerance;
    }
  }

  // 2. Health, Food & Vitals Deltas
  const healthDelta = (preAgent.health !== undefined && postAgent.health !== undefined)
    ? Math.round((postAgent.health - preAgent.health) * 10) / 10
    : null;

  const damageTaken = healthDelta !== null && healthDelta < 0 ? Math.abs(healthDelta) : 0;

  const foodDelta = (preAgent.food !== undefined && postAgent.food !== undefined)
    ? postAgent.food - preAgent.food
    : null;

  // 3. Inventory Deltas (Tracking item changes)
  const inventoryDeltas = {};
  const preCounts = {};
  const postCounts = {};

  if (Array.isArray(preObservation.inventory)) {
    for (const item of preObservation.inventory) {
      preCounts[item.name] = (preCounts[item.name] || 0) + item.count;
    }
  }
  if (Array.isArray(postObservation.inventory)) {
    for (const item of postObservation.inventory) {
      postCounts[item.name] = (postCounts[item.name] || 0) + item.count;
    }
  }

  const allItemNames = new Set([...Object.keys(preCounts), ...Object.keys(postCounts)]);
  for (const name of allItemNames) {
    const diff = (postCounts[name] || 0) - (preCounts[name] || 0);
    if (diff !== 0) {
      inventoryDeltas[name] = diff;
    }
  }

  // 4. Determine whether predicted / expected outcome was met
  let predictedOutcomeMet = false;
  if (executionResult.status === 'success') {
    switch (action) {
      case 'navigate_to':
        predictedOutcomeMet = targetReached !== false;
        break;
      case 'collect_resource':
        const targetRes = args.resource;
        predictedOutcomeMet = targetRes ? (inventoryDeltas[targetRes] || 0) > 0 : Object.values(inventoryDeltas).some(v => v > 0);
        break;
      case 'eat_food':
        predictedOutcomeMet = (foodDelta !== null && foodDelta > 0) || Object.values(inventoryDeltas).some(v => v < 0);
        break;
      case 'craft_item':
        const craftedItem = args.item;
        predictedOutcomeMet = craftedItem ? (inventoryDeltas[craftedItem] || 0) > 0 : Object.values(inventoryDeltas).some(v => v > 0);
        break;
      case 'inspect_inventory':
      case 'look_around':
      case 'stop':
        predictedOutcomeMet = true;
        break;
      default:
        predictedOutcomeMet = executionResult.status === 'success';
    }
  }

  // 5. Calculate measurable reward
  let reward = 0;
  if (predictedOutcomeMet) reward += 1.0;
  if (damageTaken > 0) reward -= Math.min(1.0, damageTaken * 0.1);
  if (executionResult.status === 'failed') reward -= 0.5;
  if (executionResult.status === 'timeout') reward -= 0.3;
  if (!postAgent.isAlive) reward -= 2.0;

  return {
    status: executionResult.status || 'unknown',
    duration_ms: executionResult.duration_ms || 0,
    error_code: executionResult.error_code || null,
    position_delta: positionDelta,
    target_reached: targetReached,
    distance_to_target: distanceToTarget,
    health_delta: healthDelta,
    damage_taken: damageTaken,
    food_delta: foodDelta,
    resource_delta: inventoryDeltas,
    predicted_outcome_met: predictedOutcomeMet,
    task_progress: predictedOutcomeMet ? 1 : 0,
    reward: Math.round(reward * 100) / 100
  };
}

export default evaluateOutcome;
