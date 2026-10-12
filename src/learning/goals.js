/**
 * Survival Goals, Dependencies, Prerequisites, and Completion Verification.
 * Models tasks as a dependency graph rather than fixed scripts.
 */

export const GOAL_DEFINITIONS = {
  // Phase A: Spawn and Survive
  SURVIVE_IMMEDIATE_THREAT: {
    id: 'SURVIVE_IMMEDIATE_THREAT',
    name: 'Evade or defend against immediate threat',
    category: 'survival',
    priorityScore: 100,
    checkPrerequisites: (obs) => ({ satisfied: true, missing: [] }),
    isCompleted: (obs) => {
      const threats = obs?.nearby_threats || [];
      const criticalThreat = threats.some(t => t.distance <= 4.0);
      return { completed: !criticalThreat, reason: criticalThreat ? 'Threat still within 4m' : 'Clear of immediate danger' };
    },
    targetAction: 'retreat_and_heal'
  },

  BUILD_EMERGENCY_SHELTER: {
    id: 'BUILD_EMERGENCY_SHELTER',
    name: 'Construct and secure emergency shelter',
    category: 'survival',
    priorityScore: 85,
    dependencies: ['GATHER_SHELTER_BLOCKS'],
    checkPrerequisites: (obs) => {
      const blockCount = countAvailableBuildingBlocks(obs);
      if (blockCount >= 8) {
        return { satisfied: true, missing: [] };
      }
      return {
        satisfied: false,
        missing: [`Need at least 8 solid building blocks (have ${blockCount})`]
      };
    },
    isCompleted: (obs) => {
      // Completed if verified safe enclosure
      const isSheltered = obs?.shelter_safety?.safe === true;
      return { completed: isSheltered, reason: isSheltered ? 'Shelter enclosure verified safe' : 'Not fully enclosed in shelter' };
    },
    targetAction: 'build_shelter'
  },

  GATHER_SHELTER_BLOCKS: {
    id: 'GATHER_SHELTER_BLOCKS',
    name: 'Gather dirt or sand blocks for shelter',
    category: 'gathering',
    priorityScore: 80,
    dependencies: [],
    checkPrerequisites: (obs) => ({ satisfied: true, missing: [] }),
    isCompleted: (obs) => {
      const count = countAvailableBuildingBlocks(obs);
      return { completed: count >= 8, reason: `Have ${count}/8 building blocks` };
    },
    targetAction: 'collect_resource',
    defaultArguments: (obs) => {
      // Choose dirt or sand depending on environment
      const hasDirt = (obs?.nearby_resources || []).some(r => r.name === 'dirt');
      return { resource: hasDirt ? 'dirt' : 'sand', count: 8 };
    }
  },

  // Phase B: Learn Wood and Crafting
  GATHER_WOOD_LOGS: {
    id: 'GATHER_WOOD_LOGS',
    name: 'Locate tree and gather logs',
    category: 'gathering',
    priorityScore: 60,
    dependencies: [],
    checkPrerequisites: (obs) => ({ satisfied: true, missing: [] }),
    isCompleted: (obs) => {
      const count = countWoodLogs(obs);
      return { completed: count >= 3, reason: `Have ${count}/3 logs` };
    },
    targetAction: 'collect_resource',
    defaultArguments: (obs) => {
      const logResource = (obs?.nearby_resources || []).find(r => r.name.includes('_log'));
      return { resource: logResource ? logResource.name : 'oak_log', count: 3 };
    }
  },

  CRAFT_PLANKS: {
    id: 'CRAFT_PLANKS',
    name: 'Convert logs into wood planks',
    category: 'crafting',
    priorityScore: 55,
    dependencies: ['GATHER_WOOD_LOGS'],
    checkPrerequisites: (obs) => {
      const logs = countWoodLogs(obs);
      if (logs >= 1) return { satisfied: true, missing: [] };
      return { satisfied: false, missing: ['Need at least 1 wood log in inventory'] };
    },
    isCompleted: (obs) => {
      const planks = countPlanks(obs);
      return { completed: planks >= 4, reason: `Have ${planks}/4 planks` };
    },
    targetAction: 'craft_item',
    defaultArguments: (obs) => ({ item: getPlankTypeFromInventory(obs) || 'oak_planks', count: 1 })
  },

  CRAFT_STICKS: {
    id: 'CRAFT_STICKS',
    name: 'Craft sticks from planks',
    category: 'crafting',
    priorityScore: 50,
    dependencies: ['CRAFT_PLANKS'],
    checkPrerequisites: (obs) => {
      const planks = countPlanks(obs);
      if (planks >= 2) return { satisfied: true, missing: [] };
      return { satisfied: false, missing: ['Need at least 2 planks to craft sticks'] };
    },
    isCompleted: (obs) => {
      const sticks = getItemCount(obs, 'stick');
      return { completed: sticks >= 4, reason: `Have ${sticks}/4 sticks` };
    },
    targetAction: 'craft_item',
    defaultArguments: () => ({ item: 'stick', count: 1 })
  },

  CRAFT_CRAFTING_TABLE: {
    id: 'CRAFT_CRAFTING_TABLE',
    name: 'Craft a crafting table',
    category: 'crafting',
    priorityScore: 48,
    dependencies: ['CRAFT_PLANKS'],
    checkPrerequisites: (obs) => {
      const planks = countPlanks(obs);
      if (planks >= 4) return { satisfied: true, missing: [] };
      return { satisfied: false, missing: [`Need 4 planks for crafting table (have ${planks})`] };
    },
    isCompleted: (obs) => {
      const hasTable = getItemCount(obs, 'crafting_table') >= 1 || hasNearbyCraftingTable(obs);
      return { completed: hasTable, reason: hasTable ? 'Crafting table available' : 'Crafting table missing' };
    },
    targetAction: 'craft_item',
    defaultArguments: () => ({ item: 'crafting_table', count: 1 })
  },

  CRAFT_WOODEN_PICKAXE: {
    id: 'CRAFT_WOODEN_PICKAXE',
    name: 'Craft a wooden pickaxe',
    category: 'crafting',
    priorityScore: 45,
    dependencies: ['CRAFT_CRAFTING_TABLE', 'CRAFT_STICKS', 'CRAFT_PLANKS'],
    checkPrerequisites: (obs) => {
      const missing = [];
      const planks = countPlanks(obs);
      const sticks = getItemCount(obs, 'stick');
      const table = getItemCount(obs, 'crafting_table') >= 1 || hasNearbyCraftingTable(obs);

      if (planks < 3) missing.push(`Need 3 planks (have ${planks})`);
      if (sticks < 2) missing.push(`Need 2 sticks (have ${sticks})`);
      if (!table) missing.push('Crafting table required within reach');

      return { satisfied: missing.length === 0, missing };
    },
    isCompleted: (obs) => {
      const hasPick = getItemCount(obs, 'wooden_pickaxe') >= 1 || countTotalPickaxes(obs) >= 1;
      return { completed: hasPick, reason: hasPick ? 'Wooden pickaxe in inventory' : 'Missing wooden pickaxe' };
    },
    targetAction: 'craft_item',
    defaultArguments: () => ({ item: 'wooden_pickaxe', count: 1 })
  },

  // Phase C: Learn Stone and Tools
  MINE_STONE: {
    id: 'MINE_STONE',
    name: 'Mine cobblestone using pickaxe',
    category: 'gathering',
    priorityScore: 40,
    dependencies: ['CRAFT_WOODEN_PICKAXE'],
    checkPrerequisites: (obs) => {
      const pickaxeCount = countTotalPickaxes(obs);
      if (pickaxeCount >= 1) return { satisfied: true, missing: [] };
      return { satisfied: false, missing: ['A pickaxe is required to mine and collect stone/cobblestone!'] };
    },
    isCompleted: (obs) => {
      const stone = getItemCount(obs, 'cobblestone');
      return { completed: stone >= 3, reason: `Have ${stone}/3 cobblestone` };
    },
    targetAction: 'collect_resource',
    defaultArguments: () => ({ resource: 'stone', count: 3 })
  },

  CRAFT_STONE_TOOLS: {
    id: 'CRAFT_STONE_TOOLS',
    name: 'Craft stone pickaxe and sword',
    category: 'crafting',
    priorityScore: 35,
    dependencies: ['MINE_STONE', 'CRAFT_STICKS', 'CRAFT_CRAFTING_TABLE'],
    checkPrerequisites: (obs) => {
      const stone = getItemCount(obs, 'cobblestone');
      const sticks = getItemCount(obs, 'stick');
      const table = getItemCount(obs, 'crafting_table') >= 1 || hasNearbyCraftingTable(obs);
      const missing = [];
      if (stone < 3) missing.push(`Need 3 cobblestone (have ${stone})`);
      if (sticks < 2) missing.push(`Need 2 sticks (have ${sticks})`);
      if (!table) missing.push('Crafting table required');
      return { satisfied: missing.length === 0, missing };
    },
    isCompleted: (obs) => {
      const hasStonePick = getItemCount(obs, 'stone_pickaxe') >= 1;
      return { completed: hasStonePick, reason: hasStonePick ? 'Stone pickaxe crafted' : 'No stone pickaxe' };
    },
    targetAction: 'craft_item',
    defaultArguments: () => ({ item: 'stone_pickaxe', count: 1 })
  },

  CRAFT_STONE_SWORD: {
    id: 'CRAFT_STONE_SWORD',
    name: 'Craft stone sword for defense and hunting',
    category: 'crafting',
    priorityScore: 36,
    dependencies: ['MINE_STONE', 'CRAFT_STICKS', 'CRAFT_CRAFTING_TABLE'],
    checkPrerequisites: (obs) => {
      const stone = getItemCount(obs, 'cobblestone');
      const sticks = getItemCount(obs, 'stick');
      const table = getItemCount(obs, 'crafting_table') >= 1 || hasNearbyCraftingTable(obs);
      const missing = [];
      if (stone < 2) missing.push(`Need 2 cobblestone (have ${stone})`);
      if (sticks < 1) missing.push(`Need 1 stick (have ${sticks})`);
      if (!table) missing.push('Crafting table required');
      return { satisfied: missing.length === 0, missing };
    },
    isCompleted: (obs) => {
      const hasSword = (obs?.inventory || []).some(i => i.name.includes('_sword'));
      return { completed: hasSword, reason: hasSword ? 'Sword crafted' : 'No sword' };
    },
    targetAction: 'craft_item',
    defaultArguments: () => ({ item: 'stone_sword', count: 1 })
  },

  CRAFT_STONE_AXE: {
    id: 'CRAFT_STONE_AXE',
    name: 'Craft stone axe for timber and combat',
    category: 'crafting',
    priorityScore: 34,
    dependencies: ['MINE_STONE', 'CRAFT_STICKS', 'CRAFT_CRAFTING_TABLE'],
    checkPrerequisites: (obs) => {
      const stone = getItemCount(obs, 'cobblestone');
      const sticks = getItemCount(obs, 'stick');
      const table = getItemCount(obs, 'crafting_table') >= 1 || hasNearbyCraftingTable(obs);
      const missing = [];
      if (stone < 3) missing.push(`Need 3 cobblestone (have ${stone})`);
      if (sticks < 2) missing.push(`Need 2 sticks (have ${sticks})`);
      if (!table) missing.push('Crafting table required');
      return { satisfied: missing.length === 0, missing };
    },
    isCompleted: (obs) => {
      const hasAxe = (obs?.inventory || []).some(i => i.name.includes('_axe'));
      return { completed: hasAxe, reason: hasAxe ? 'Axe crafted' : 'No axe' };
    },
    targetAction: 'craft_item',
    defaultArguments: () => ({ item: 'stone_axe', count: 1 })
  },

  CRAFT_FURNACE: {
    id: 'CRAFT_FURNACE',
    name: 'Craft furnace for smelting and cooking',
    category: 'crafting',
    priorityScore: 33,
    dependencies: ['MINE_STONE', 'CRAFT_CRAFTING_TABLE'],
    checkPrerequisites: (obs) => {
      const stone = getItemCount(obs, 'cobblestone');
      const table = getItemCount(obs, 'crafting_table') >= 1 || hasNearbyCraftingTable(obs);
      const missing = [];
      if (stone < 8) missing.push(`Need 8 cobblestone (have ${stone})`);
      if (!table) missing.push('Crafting table required');
      return { satisfied: missing.length === 0, missing };
    },
    isCompleted: (obs) => {
      const hasFurnace = getItemCount(obs, 'furnace') >= 1;
      return { completed: hasFurnace, reason: hasFurnace ? 'Furnace crafted' : 'No furnace' };
    },
    targetAction: 'craft_item',
    defaultArguments: () => ({ item: 'furnace', count: 1 })
  },

  CRAFT_CHEST: {
    id: 'CRAFT_CHEST',
    name: 'Craft chest for resource storage',
    category: 'crafting',
    priorityScore: 32,
    dependencies: ['CRAFT_PLANKS', 'CRAFT_CRAFTING_TABLE'],
    checkPrerequisites: (obs) => {
      const planks = countPlanks(obs);
      const table = getItemCount(obs, 'crafting_table') >= 1 || hasNearbyCraftingTable(obs);
      const missing = [];
      if (planks < 8) missing.push(`Need 8 planks (have ${planks})`);
      if (!table) missing.push('Crafting table required');
      return { satisfied: missing.length === 0, missing };
    },
    isCompleted: (obs) => {
      const hasChest = getItemCount(obs, 'chest') >= 1;
      return { completed: hasChest, reason: hasChest ? 'Chest crafted' : 'No chest' };
    },
    targetAction: 'craft_item',
    defaultArguments: () => ({ item: 'chest', count: 1 })
  },

  CRAFT_SHIELD: {
    id: 'CRAFT_SHIELD',
    name: 'Craft shield for defense',
    category: 'crafting',
    priorityScore: 31,
    dependencies: ['CRAFT_PLANKS', 'CRAFT_CRAFTING_TABLE'],
    checkPrerequisites: (obs) => {
      const planks = countPlanks(obs);
      const iron = getItemCount(obs, 'iron_ingot');
      const table = getItemCount(obs, 'crafting_table') >= 1 || hasNearbyCraftingTable(obs);
      const missing = [];
      if (planks < 6) missing.push(`Need 6 planks (have ${planks})`);
      if (iron < 1) missing.push(`Need 1 iron ingot (have ${iron})`);
      if (!table) missing.push('Crafting table required');
      return { satisfied: missing.length === 0, missing };
    },
    isCompleted: (obs) => {
      const hasShield = getItemCount(obs, 'shield') >= 1 || (obs?.equipment?.offhand?.name === 'shield');
      return { completed: hasShield, reason: hasShield ? 'Shield crafted' : 'No shield' };
    },
    targetAction: 'craft_item',
    defaultArguments: () => ({ item: 'shield', count: 1 })
  },

  // Phase D: Food and Health
  EAT_FOOD: {
    id: 'EAT_FOOD',
    name: 'Consume food to restore hunger and health',
    category: 'sustenance',
    priorityScore: 75,
    dependencies: ['GATHER_FOOD'],
    checkPrerequisites: (obs) => {
      const foodCount = countEdibleFood(obs);
      if (foodCount >= 1) return { satisfied: true, missing: [] };
      return { satisfied: false, missing: ['No edible food available in inventory'] };
    },
    isCompleted: (obs) => {
      const food = obs?.agent?.food ?? 20;
      return { completed: food >= 18, reason: `Food level is ${food}/20` };
    },
    targetAction: 'eat_food',
    defaultArguments: () => ({})
  },

  GATHER_FOOD: {
    id: 'GATHER_FOOD',
    name: 'Gather reachable food sources',
    category: 'sustenance',
    priorityScore: 70,
    dependencies: [],
    checkPrerequisites: (obs) => ({ satisfied: true, missing: [] }),
    isCompleted: (obs) => {
      const count = countEdibleFood(obs);
      return { completed: count >= 2, reason: `Have ${count}/2 food items` };
    },
    targetAction: 'collect_resource',
    defaultArguments: (obs) => {
      const foodRes = (obs?.nearby_resources || []).find(r => ['apple', 'sweet_berries', 'bread', 'carrot'].includes(r.name));
      return { resource: foodRes ? foodRes.name : 'sweet_berries' };
    }
  },

  RECOVER_LOST_ITEMS: {
    id: 'RECOVER_LOST_ITEMS',
    name: 'Navigate to death drop location and recover lost items',
    category: 'recovery',
    priorityScore: 78,
    dependencies: [],
    checkPrerequisites: (obs) => {
      const lost = obs?.known_locations?.lost_things;
      if (lost && lost.position) return { satisfied: true, missing: [] };
      return { satisfied: false, missing: ['No active lost items location recorded'] };
    },
    isCompleted: (obs) => {
      const lost = obs?.known_locations?.lost_things;
      if (!lost) return { completed: true, reason: 'No lost items location active' };
      const pos = obs?.agent?.position;
      if (pos && lost.position) {
        const dist = Math.hypot(lost.position.x - pos.x, lost.position.z - pos.z);
        if (dist <= 2.5) return { completed: true, reason: 'Reached lost items location' };
      }
      return { completed: false, reason: 'Have not reached lost items location' };
    },
    targetAction: 'navigate_to',
    defaultArguments: (obs) => {
      const lost = obs?.known_locations?.lost_things;
      return lost?.position ? { x: lost.position.x, y: lost.position.y, z: lost.position.z, range: 1.5 } : { x: 0, z: 0 };
    }
  },

  RETURN_TO_SHELTER_BASE: {
    id: 'RETURN_TO_SHELTER_BASE',
    name: 'Return to remembered shelter base for safety',
    category: 'survival',
    priorityScore: 88,
    dependencies: [],
    checkPrerequisites: (obs) => {
      const base = obs?.known_locations?.shelter_base;
      if (base && base.position) return { satisfied: true, missing: [] };
      return { satisfied: false, missing: ['No shelter base location remembered'] };
    },
    isCompleted: (obs) => {
      const base = obs?.known_locations?.shelter_base;
      const isSheltered = obs?.shelter_safety?.safe === true;
      if (isSheltered) return { completed: true, reason: 'Safely enclosed in shelter' };
      const pos = obs?.agent?.position;
      if (pos && base?.position) {
        const dist = Math.hypot(base.position.x - pos.x, base.position.z - pos.z);
        if (dist <= 2.5) return { completed: true, reason: 'Arrived at shelter base location' };
      }
      return { completed: false, reason: 'Not yet at shelter base' };
    },
    targetAction: 'navigate_to',
    defaultArguments: (obs) => {
      const base = obs?.known_locations?.shelter_base;
      return base?.position ? { x: base.position.x, y: base.position.y, z: base.position.z, range: 2.0 } : { x: 0, z: 0 };
    }
  }
};

/**
 * Resolves a goal into an ordered sequence of sub-goals based on unsatisfied prerequisites.
 * If the goal's prerequisites are not met, recursively finds the necessary prerequisite tasks.
 * @param {string} goalId
 * @param {Object} observation
 * @param {Set} [visited] Prevent cyclic dependencies
 * @returns {Array<string>} Ordered goal IDs to execute
 */
export function resolveGoalPlan(goalId, observation, visited = new Set()) {
  const def = GOAL_DEFINITIONS[goalId];
  if (!def) return [];

  if (visited.has(goalId)) return [];
  visited.add(goalId);

  // Check if goal is already completed (skip redundant work!)
  const completion = def.isCompleted(observation);
  if (completion.completed) {
    return [];
  }

  // Check prerequisites
  const prereq = def.checkPrerequisites(observation);
  if (prereq.satisfied) {
    return [goalId];
  }

  // If prerequisites are missing, resolve dependencies
  const plan = [];
  for (const depId of def.dependencies || []) {
    const subPlan = resolveGoalPlan(depId, observation, visited);
    for (const step of subPlan) {
      if (!plan.includes(step)) {
        plan.push(step);
      }
    }
  }

  // If all dependencies are satisfied or queued, add this goal
  if (!plan.includes(goalId)) {
    plan.push(goalId);
  }

  return plan;
}

// Helper Functions
export function countAvailableBuildingBlocks(obs) {
  if (!obs || !obs.inventory) return 0;
  const buildingBlockNames = ['dirt', 'cobblestone', 'sand', 'sandstone', 'oak_planks', 'birch_planks', 'spruce_planks', 'deepslate'];
  let total = 0;
  for (const item of obs.inventory) {
    if (buildingBlockNames.some(b => item.name === b || item.name.includes(b))) {
      total += (item.count || 1);
    }
  }
  return total;
}

export function countWoodLogs(obs) {
  if (!obs || !obs.inventory) return 0;
  let count = 0;
  for (const item of obs.inventory) {
    if (item.name && item.name.includes('_log')) {
      count += (item.count || 1);
    }
  }
  return count;
}

export function countPlanks(obs) {
  if (!obs || !obs.inventory) return 0;
  let count = 0;
  for (const item of obs.inventory) {
    if (item.name && item.name.includes('_planks')) {
      count += (item.count || 1);
    }
  }
  return count;
}

export function countTotalPickaxes(obs) {
  if (!obs || !obs.inventory) return 0;
  return obs.inventory.filter(i => i.name && i.name.includes('_pickaxe')).reduce((sum, i) => sum + (i.count || 1), 0);
}

export function countEdibleFood(obs) {
  if (!obs || !obs.inventory) return 0;
  const foodKeywords = ['beef', 'porkchop', 'mutton', 'chicken', 'bread', 'apple', 'carrot', 'potato', 'cookie', 'melon_slice', 'sweet_berries'];
  let count = 0;
  for (const item of obs.inventory) {
    if (item.name && foodKeywords.some(k => item.name.includes(k))) {
      count += (item.count || 1);
    }
  }
  return count;
}

export function getItemCount(obs, itemName) {
  if (!obs || !obs.inventory) return 0;
  const item = obs.inventory.find(i => i.name === itemName);
  return item ? item.count : 0;
}

export function hasNearbyCraftingTable(obs) {
  if (!obs) return false;
  return (obs.nearby_resources || []).some(r => r.name === 'crafting_table' && r.distance <= 4.0);
}

export function getPlankTypeFromInventory(obs) {
  if (!obs || !obs.inventory) return 'oak_planks';
  const log = obs.inventory.find(i => i.name && i.name.includes('_log'));
  if (log) {
    const woodType = log.name.replace('_log', '');
    return `${woodType}_planks`;
  }
  return 'oak_planks';
}

export default {
  GOAL_DEFINITIONS,
  resolveGoalPlan,
  countAvailableBuildingBlocks,
  countWoodLogs,
  countPlanks,
  countTotalPickaxes,
  countEdibleFood,
  getItemCount
};
