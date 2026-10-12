/**
 * Core ALife Survival Directives & Rules Engine.
 * 
 * Rules:
 * 1. Collect Logs & Wood early to craft basic tools, crafting tables, and building blocks.
 * 2. Find and consume food to keep hunger >= 18 and maintain health.
 * 3. Monitor the day/night cycle and build/enter shelter before dusk/nightfall.
 */

export const SURVIVAL_RULES = [
  {
    id: 'RULE_WOOD_COLLECTION',
    name: 'Collect Logs Early',
    priority: 1,
    description: 'During morning and midday, collect wood/logs or sticks. Wood is the vital prerequisite for crafting tools, weapons, and shelter materials.',
    trigger: (obs) => {
      const logs = countLogs(obs);
      const isDay = obs?.environment?.isDay !== false;
      const time = obs?.environment?.time ?? 0;
      return isDay && time < 9000 && logs < 4;
    },
    suggestedGoal: 'collect wood logs for crafting tools and shelter materials',
    recommendedAction: 'collect_resource',
    recommendedResource: 'oak_log'
  },
  {
    id: 'RULE_FOOD_AND_HEALTH',
    name: 'Maintain Sustenance & Hunger',
    priority: 2,
    description: 'Monitor hunger and health. If food < 18 and food is held, eat immediately. If starving (food <= 14) and empty, prioritize gathering edible items.',
    trigger: (obs) => {
      const food = obs?.agent?.food ?? 20;
      const health = obs?.agent?.health ?? 20;
      return food < 18 || health < 15;
    },
    suggestedGoal: 'restore hunger and health',
    recommendedAction: 'eat_food'
  },
  {
    id: 'RULE_SHELTER_BEFORE_NIGHT',
    name: 'Build Shelter Before Night',
    priority: 3,
    description: 'Monitor time of day. Daylight ends at tick 12000; night falls at tick 13000 when dangerous hostile mobs spawn. When afternoon arrives (tick 9000+), stop wandering and prepare or build shelter before night falls.',
    trigger: (obs) => {
      const time = obs?.environment?.time;
      const isDay = obs?.environment?.isDay;
      if (isDay === false) return true; // It is already night!
      if (typeof time === 'number' && time >= 9000) return true; // Afternoon or dusk!
      return false;
    },
    suggestedGoal: 'prepare shelter and secure safe position before night',
    recommendedAction: 'place_block'
  }
];

/**
 * Counts available logs or wood in inventory.
 * @param {Object} obs 
 * @returns {number}
 */
export function countLogs(obs) {
  if (!obs || !obs.inventory) return 0;
  let count = 0;
  for (const item of obs.inventory) {
    if (item.name && (item.name.includes('_log') || item.name.includes('_planks') || item.name === 'dead_bush')) {
      count += (item.count || 1);
    }
  }
  return count;
}

/**
 * Counts edible food items in inventory.
 * @param {Object} obs 
 * @returns {number}
 */
export function countFoodItems(obs) {
  if (!obs || !obs.inventory) return 0;
  const edibleKeywords = ['beef', 'porkchop', 'mutton', 'chicken', 'bread', 'apple', 'carrot', 'potato', 'cookie', 'melon_slice'];
  let count = 0;
  for (const item of obs.inventory) {
    if (item.name && edibleKeywords.some(k => item.name.includes(k))) {
      count += (item.count || 1);
    }
  }
  return count;
}

/**
 * Analyzes current world & agent state against the core survival rules.
 * @param {Object} observation 
 * @returns {Object} Survival analysis and recommendations
 */
export function evaluateSurvivalDirectives(observation) {
  if (!observation || !observation.agent) {
    return { phase: 'unknown', recommendations: [] };
  }

  const agent = observation.agent;
  const env = observation.environment || {};
  const time = typeof env.time === 'number' ? env.time : 6000;
  const isDay = env.isDay !== false;

  const logsCount = countLogs(observation);
  const foodCount = countFoodItems(observation);

  // Time Phase Determination
  let timePhase = 'day';
  let nightWarning = 'Safe daylight. Explore and gather.';

  if (time >= 0 && time < 6000) {
    timePhase = 'morning';
    nightWarning = 'Early morning. Prime time to gather wood and tools.';
  } else if (time >= 6000 && time < 9000) {
    timePhase = 'midday';
    nightWarning = 'Midday. Continue gathering wood, tools, and food.';
  } else if (time >= 9000 && time < 12000) {
    timePhase = 'afternoon_prepare_shelter';
    nightWarning = 'WARNING: Afternoon! Night approaches in ~2 minutes. Cease long exploration and prepare shelter!';
  } else if (time >= 12000 && time < 13000) {
    timePhase = 'dusk_sunset';
    nightWarning = 'CRITICAL: Sun is setting! Enter or build shelter IMMEDIATELY before hostile mobs spawn!';
  } else if (!isDay || (time >= 13000 && time < 23000)) {
    timePhase = 'night_dangerous';
    nightWarning = 'DANGER: It is night! Hostile mobs are active outside. Remain inside shelter or retreat to safety.';
  } else {
    timePhase = 'dawn';
    nightWarning = 'Dawn approaching. Mobs burn in sunlight soon.';
  }

  // Active Directives & Urgencies
  const directives = [];

  // Directive 1: Shelter before night
  if (timePhase === 'afternoon_prepare_shelter' || timePhase === 'dusk_sunset' || timePhase === 'night_dangerous') {
    directives.push({
      rule: 'RULE_SHELTER_BEFORE_NIGHT',
      urgency: timePhase === 'dusk_sunset' || timePhase === 'night_dangerous' ? 'critical' : 'high',
      directive: timePhase === 'night_dangerous'
        ? 'Stay inside shelter or safe barrier; avoid venturing into dark open terrain.'
        : 'Night approaches soon! Gather building blocks (dirt/sand/wood) and construct or enter shelter.',
      recommended_action: 'place_block'
    });
  }

  // Directive 2: Sustenance
  if (agent.food < 18 || agent.health < 15) {
    directives.push({
      rule: 'RULE_FOOD_AND_HEALTH',
      urgency: agent.food <= 10 ? 'critical' : 'high',
      directive: foodCount > 0
        ? `Hunger is low (${agent.food}/20). Consume food from inventory immediately.`
        : `Hunger is low (${agent.food}/20) and no food in inventory! Prioritize hunting or foraging for food.`,
      recommended_action: foodCount > 0 ? 'eat_food' : 'collect_resource'
    });
  }

  // Directive 3: Wood gathering (if daylight and wood is low)
  if (isDay && time < 9000 && logsCount < 4) {
    directives.push({
      rule: 'RULE_WOOD_COLLECTION',
      urgency: 'medium',
      directive: `Only ${logsCount} wood/logs in inventory. Harvest nearby logs or dead bushes to craft tools and crafting table.`,
      recommended_action: 'collect_resource'
    });
  }

  return {
    time_of_day: {
      ticks: time,
      phase: timePhase,
      is_day: isDay,
      warning: nightWarning
    },
    inventory_supplies: {
      logs_count: logsCount,
      food_count: foodCount
    },
    active_directives: directives
  };
}

export default {
  SURVIVAL_RULES,
  evaluateSurvivalDirectives,
  countLogs,
  countFoodItems
};
