import { ALLOWED_ACTIONS } from '../actions/index.js';
import { evaluateSurvivalDirectives } from './survival-rules.js';
import { defaultProgression } from '../progression/state-machine.js';

export const ACTION_SCHEMAS_GUIDE = {
  look_around: { description: 'Rotate gaze safely', args: { yaw: 'number (optional)', pitch: 'number (optional)' } },
  inspect_inventory: { description: 'Check held items and empty inventory slots', args: {} },
  navigate_to: { description: 'Walk towards target coordinates using pathfinder', args: { x: 'number', y: 'number (optional)', z: 'number', range: 'number (optional, default 1.5)' } },
  collect_resource: { description: 'Dig and collect an observed nearby block', args: { resource: 'string (e.g. sand, cactus, dead_bush, oak_log, dirt)' } },
  eat_food: { description: 'Consume edible food when hungry', args: { food_name: 'string (optional)' } },
  craft_item: { description: 'Craft item if ingredients are in inventory', args: { item: 'string (e.g. stick, crafting_table, oak_planks, sword, shield)', count: 'number (optional)' } },
  place_block: { description: 'Place a block from inventory to construct shelter, barriers, or walls', args: { block: 'string (e.g. dirt, sand, cobblestone, oak_planks)', dx: 'number (optional)', dy: 'number (optional)', dz: 'number (optional)' } },
  attack_target: { description: 'Engage and strike a hostile mob with weapon cooldown timing', args: { mob: 'string (optional, e.g. zombie, skeleton, spider, husk)' } },
  defend_with_shield: { description: 'Raise offhand shield to deflect incoming projectile arrows or mob attacks', args: { duration_ms: 'number (optional)' } },
  retreat_and_heal: { description: 'Disengage from combat, pathfind to safe retreat distance, and consume food', args: {} },
  equip_gear: { description: 'Auto-equip best available armor, weapons, and offhand shield from inventory', args: {} },
  store_in_chest: { description: 'Store surplus resources into a nearby chest container', args: {} },
  farm_crop: { description: 'Harvest fully mature crops (wheat/carrots/potatoes) and replant seeds', args: {} },
  stop: { description: 'Halt all actions and remain idle in a safe position', args: { reason: 'string (optional)' } }
};

/**
 * Builds a compact, bounded reasoning context for Qwen 3.5 9B.
 * @param {Object} params
 * @param {Object} params.observation - Current world snapshot
 * @param {string} [params.goal] - High level objective
 * @param {Object} [params.previousOutcome] - Outcome of last action
 * @param {Array} [params.memories] - Relevant past failure/success memories
 * @returns {Object} Compact context object
 */
export function buildReasoningContext({ observation, goal = 'survive and explore', previousOutcome = null, memories = [], memoryStore = null }) {
  if (!observation || !observation.agent) {
    return { error: 'Incomplete observation' };
  }

  const agent = observation.agent;
  const env = observation.environment || {};
  const survivalAnalysis = evaluateSurvivalDirectives(observation);
  const progressionStatus = defaultProgression.getStatusSummary(observation);

  return {
    current_goal: goal,
    progression: {
      current_stage: progressionStatus.stage,
      stage_title: progressionStatus.title,
      advancement_ready: progressionStatus.advancement_ready,
      next_stage: progressionStatus.next_stage,
      prerequisites_checklist: progressionStatus.prerequisites_checklist
    },
    time_of_day: survivalAnalysis.time_of_day,
    survival_directives: survivalAnalysis.active_directives,
    agent_state: {
      position: agent.position,
      health: `${agent.health}/20`,
      food: `${agent.food}/20`,
      isDay: env.isDay,
      dimension: env.dimension
    },
    inventory: (observation.inventory || []).map(i => `${i.name} x${i.count}`),
    nearby_threats: (observation.nearby_threats || []).map(t => `${t.name} (${t.distance}m away)`),
    nearby_resources: (observation.nearby_resources || []).map(r => `${r.name} (${r.distance}m away at ${r.position.x},${r.position.y},${r.position.z})`),
    allowed_actions: ALLOWED_ACTIONS,
    action_reference: ACTION_SCHEMAS_GUIDE,
    previous_outcome: previousOutcome ? {
      action: previousOutcome.action,
      status: previousOutcome.status,
      predicted_outcome_met: previousOutcome.predicted_outcome_met,
      deltas: previousOutcome.resource_delta || previousOutcome.position_delta
    } : null,
    prior_memories: memories.slice(0, 3),
    proven_strategy: memoryStore && typeof memoryStore.getBestStrategy === 'function'
      ? memoryStore.getBestStrategy(goal, observation)
      : null,
    known_locations: observation.known_locations || (memoryStore && typeof memoryStore.getKnownLocationsSummary === 'function' ? memoryStore.getKnownLocationsSummary() : null),
    last_death: observation.last_death || (memoryStore && typeof memoryStore.getLastDeathInfo === 'function' ? memoryStore.getLastDeathInfo() : null)
  };
}

export default buildReasoningContext;
