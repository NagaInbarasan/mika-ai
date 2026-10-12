import {
  countAvailableBuildingBlocks,
  countWoodLogs,
  countPlanks,
  countTotalPickaxes,
  countEdibleFood,
  getItemCount,
  resolveGoalPlan
} from '../learning/goals.js';

/**
 * Survival Priority Configuration and Centralized Thresholds.
 */
export const SURVIVAL_CONFIG = {
  HEALTH_CRITICAL: 6,       // 3 hearts - critical retreat
  HEALTH_LOW: 12,           // 6 hearts
  HEALTH_MAX: 20,
  HUNGER_CRITICAL: 6,       // 3 shanks - sprint disabled / starving soon
  HUNGER_HUNGRY: 14,        // Food needed for health regeneration
  TIME_DUSK_WARNING: 10500, // Sun descending
  TIME_NIGHT_START: 12500,  // Nightfall & mob spawning
  TIME_NIGHT_END: 23000,    // Sunrise
  SHELTER_MIN_BLOCKS: 8,
  THREAT_PANIC_DISTANCE: 5.0,
  ACTION_TIMEOUT_MS: 30000,
  MAX_RETRIES_PER_GOAL: 3
};

/**
 * Tracks goal execution history to prevent infinite failure loops.
 */
export class GoalExecutionTracker {
  constructor(maxRetries = SURVIVAL_CONFIG.MAX_RETRIES_PER_GOAL) {
    this.maxRetries = maxRetries;
    this.attempts = new Map(); // goalId -> failure count
    this.history = [];
    this.abortedGoals = new Set();
  }

  recordAttempt(goalId, success, reason = '') {
    this.history.push({
      goalId,
      success,
      reason,
      timestamp: Date.now()
    });

    if (success) {
      this.attempts.set(goalId, 0);
      this.abortedGoals.delete(goalId);
      // When any action succeeds, world/inventory state changed; unblock other goals for fresh re-evaluation
      for (const blocked of Array.from(this.abortedGoals)) {
        this.attempts.set(blocked, 0);
        this.abortedGoals.delete(blocked);
      }
    } else {
      const currentFailures = (this.attempts.get(goalId) || 0) + 1;
      this.attempts.set(goalId, currentFailures);
      if (currentFailures >= this.maxRetries) {
        this.abortedGoals.add(goalId);
        if (!this.blockedTimestamps) this.blockedTimestamps = new Map();
        this.blockedTimestamps.set(goalId, Date.now());
      }
    }
  }

  isGoalBlocked(goalId) {
    if (!this.abortedGoals.has(goalId)) return false;
    // Automatically expire block after 30 seconds to allow retrying under new physical state
    const blockedTime = this.blockedTimestamps ? (this.blockedTimestamps.get(goalId) || 0) : 0;
    if (blockedTime > 0 && Date.now() - blockedTime > 30000) {
      this.abortedGoals.delete(goalId);
      this.attempts.set(goalId, 0);
      return false;
    }
    return true;
  }

  getFailureCount(goalId) {
    return this.attempts.get(goalId) || 0;
  }

  reset() {
    this.attempts.clear();
    this.history = [];
    this.abortedGoals.clear();
  }
}

/**
 * Evaluates whether it is currently night or approaching dusk.
 * @param {Object} obs
 * @returns {boolean}
 */
export function isNightOrDusk(obs) {
  if (!obs) return false;

  // Environment property from observe.js
  if (obs.environment) {
    if (obs.environment.is_night === true) return true;
    if (obs.environment.isDay === false) return true;
    if (obs.environment.timePhase === 'dusk_sunset' || obs.environment.timePhase === 'night_dangerous') return true;

    const t = typeof obs.environment.time === 'number'
      ? obs.environment.time
      : (typeof obs.environment.time_of_day === 'number' ? obs.environment.time_of_day : null);

    if (t !== null && t >= SURVIVAL_CONFIG.TIME_DUSK_WARNING && t <= SURVIVAL_CONFIG.TIME_NIGHT_END) {
      return true;
    }
  }

  // Raw time object from mineflayer
  if (obs.time) {
    if (obs.time.isDay === false) return true;
    if (typeof obs.time.timeOfDay === 'number') {
      const t = obs.time.timeOfDay;
      if (t >= SURVIVAL_CONFIG.TIME_DUSK_WARNING && t <= SURVIVAL_CONFIG.TIME_NIGHT_END) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluates immediate hostile mob threat.
 * @param {Object} obs
 * @returns {{ hasThreat: boolean, closestThreat: Object|null, threatCount: number }}
 */
export function evaluateThreatLevel(obs) {
  const threats = obs?.nearby_threats || [];
  const nearby = threats.filter(t => t.distance <= SURVIVAL_CONFIG.THREAT_PANIC_DISTANCE);
  return {
    hasThreat: nearby.length > 0,
    closestThreat: nearby.length > 0 ? nearby[0] : null,
    threatCount: nearby.length
  };
}

/**
 * 6-Tier Contextual Goal Prioritization Engine.
 * Dynamically prioritizes survival goals according to urgency, available resources, and mistake history.
 * 
 * Tiers:
 * 1. Immediate threats and critically low health
 * 2. Imminent nighttime or dangerous environmental conditions
 * 3. Hunger and available food
 * 4. Emergency shelter
 * 5. Essential tools and resource gathering
 * 6. Shelter upgrades and optional exploration
 * 
 * @param {Object} obs - Current observation
 * @param {Object} [memoryStore=null] - Persistent mistake memory
 * @param {GoalExecutionTracker} [tracker=null] - Execution history & retry limiter
 * @returns {{ goalId: string, tier: number, reason: string, plan: Array<string>, isFallback: boolean }}
 */
export function selectContextualGoal(obs, memoryStore = null, tracker = null) {
  const health = obs?.agent?.health ?? 20;
  const food = obs?.agent?.food ?? 20;
  const threatInfo = evaluateThreatLevel(obs);
  const isNight = isNightOrDusk(obs);
  const isSheltered = obs?.shelter_safety?.safe === true;

  const candidateGoals = [];

  // Helper to test if a goal is allowed by retry tracker
  const canAttempt = (id) => !tracker || !tracker.isGoalBlocked(id);

  // -------------------------------------------------------------
  // TIER 1: Immediate threats and critically low health
  // -------------------------------------------------------------
  if (threatInfo.hasThreat && (health <= SURVIVAL_CONFIG.HEALTH_CRITICAL || threatInfo.closestThreat?.distance <= 3.5)) {
    if (canAttempt('SURVIVE_IMMEDIATE_THREAT')) {
      candidateGoals.push({
        goalId: 'SURVIVE_IMMEDIATE_THREAT',
        tier: 1,
        reason: `Critical danger: threat at ${threatInfo.closestThreat?.distance?.toFixed(1) || '?'}m with health ${health}/${SURVIVAL_CONFIG.HEALTH_MAX}`
      });
    }
  }

  // -------------------------------------------------------------
  // TIER 2: Imminent nighttime or dangerous conditions
  // -------------------------------------------------------------
  if (isNight && !isSheltered) {
    const rememberedBase = obs?.known_locations?.shelter_base;
    const botPos = obs?.agent?.position;
    const distToBase = (rememberedBase && botPos && rememberedBase.position)
      ? Math.hypot(rememberedBase.position.x - botPos.x, rememberedBase.position.z - botPos.z)
      : Infinity;

    // If a remembered shelter base is within reasonable reach (<= 48m), prioritize returning to it!
    if (rememberedBase && distToBase <= 48 && canAttempt('RETURN_TO_SHELTER_BASE')) {
      candidateGoals.push({
        goalId: 'RETURN_TO_SHELTER_BASE',
        tier: 2,
        reason: `Night is active or approaching; returning to remembered shelter base at (${rememberedBase.position.x}, ${rememberedBase.position.z}) (${distToBase.toFixed(1)}m away)`
      });
    } else {
      const blocks = countAvailableBuildingBlocks(obs);
      if (blocks >= SURVIVAL_CONFIG.SHELTER_MIN_BLOCKS && canAttempt('BUILD_EMERGENCY_SHELTER')) {
        candidateGoals.push({
          goalId: 'BUILD_EMERGENCY_SHELTER',
          tier: 2,
          reason: `Night is active or approaching and bot is unsheltered (have ${blocks} building blocks)`
        });
      } else if (canAttempt('GATHER_SHELTER_BLOCKS')) {
        candidateGoals.push({
          goalId: 'GATHER_SHELTER_BLOCKS',
          tier: 2,
          reason: `Night is active or approaching; must gather building blocks for emergency shelter (have ${blocks}/${SURVIVAL_CONFIG.SHELTER_MIN_BLOCKS})`
        });
      }
    }
  }

  // -------------------------------------------------------------
  // TIER 3: Hunger, food sustenance, and recovery of lost items
  // -------------------------------------------------------------
  const needsFood = food <= SURVIVAL_CONFIG.HUNGER_CRITICAL || (food <= SURVIVAL_CONFIG.HUNGER_HUNGRY && health < SURVIVAL_CONFIG.HEALTH_MAX);
  if (needsFood) {
    const edibleCount = countEdibleFood(obs);
    if (edibleCount > 0 && canAttempt('EAT_FOOD')) {
      candidateGoals.push({
        goalId: 'EAT_FOOD',
        tier: 3,
        reason: `Hunger is low (${food}/${SURVIVAL_CONFIG.HEALTH_MAX}) and edible food is in inventory`
      });
    } else if (canAttempt('GATHER_FOOD')) {
      candidateGoals.push({
        goalId: 'GATHER_FOOD',
        tier: 3,
        reason: `Hunger is low (${food}/${SURVIVAL_CONFIG.HEALTH_MAX}) and no food is in inventory`
      });
    }
  }

  // Recovery of dropped items from last death location (when healthy during daytime)
  const lostThings = obs?.known_locations?.lost_things;
  if (lostThings && lostThings.position && !isNight && health >= 12 && !threatInfo.hasThreat && canAttempt('RECOVER_LOST_ITEMS')) {
    candidateGoals.push({
      goalId: 'RECOVER_LOST_ITEMS',
      tier: 3,
      reason: `Recovering items lost during last death ("${lostThings.metadata?.reason || 'death'}") at (${lostThings.position.x}, ${lostThings.position.z})`
    });
  }

  // -------------------------------------------------------------
  // TIER 4: Proactive Emergency Shelter (Daytime preparation)
  // -------------------------------------------------------------
  if (!isSheltered) {
    const blocks = countAvailableBuildingBlocks(obs);
    // If we have no shelter yet and it is daytime, ensure we prepare shelter blocks before sunset
    if (blocks < SURVIVAL_CONFIG.SHELTER_MIN_BLOCKS && canAttempt('GATHER_SHELTER_BLOCKS')) {
      // Prioritize basic shelter blocks if completely empty
      if (blocks === 0) {
        candidateGoals.push({
          goalId: 'GATHER_SHELTER_BLOCKS',
          tier: 4,
          reason: `Zero shelter blocks available; prepare emergency building blocks proactively`
        });
      }
    }
  }

  // -------------------------------------------------------------
  // TIER 5: Essential Tools and Resource Gathering Progression
  // First principles progression: Wood -> Planks -> Table -> Pickaxe -> Stone -> Stone Tools
  // -------------------------------------------------------------
  const pickaxes = countTotalPickaxes(obs);
  const cobblestone = getItemCount(obs, 'cobblestone');
  const stonePickaxe = getItemCount(obs, 'stone_pickaxe');

  // Check Stone progression first if we already have a wooden pickaxe
  if (pickaxes > 0 && stonePickaxe === 0) {
    if (cobblestone >= 3 && canAttempt('CRAFT_STONE_TOOLS')) {
      candidateGoals.push({
        goalId: 'CRAFT_STONE_TOOLS',
        tier: 5,
        reason: `Have ${cobblestone} cobblestone and wooden pickaxe; upgrade to stone tools`
      });
    } else if (canAttempt('MINE_STONE')) {
      candidateGoals.push({
        goalId: 'MINE_STONE',
        tier: 5,
        reason: `Have pickaxe; mine cobblestone to upgrade tools and capabilities`
      });
    }
  } else if (pickaxes > 0 && stonePickaxe > 0) {
    // We already have stone pickaxe! Expand Farmer tools: sword, axe, furnace, chest, food, shield
    const inv = obs?.inventory || [];
    const hasSword = inv.some(i => i.name.includes('_sword'));
    const hasAxe = inv.some(i => i.name.includes('_axe'));
    const hasFurnace = getItemCount(obs, 'furnace') > 0 || (obs?.nearby_resources || []).some(r => r.name === 'furnace' && r.distance <= 4);
    const hasChest = getItemCount(obs, 'chest') > 0 || (obs?.nearby_resources || []).some(r => r.name === 'chest' && r.distance <= 4);
    const hasShield = inv.some(i => i.name === 'shield') || obs?.equipment?.offhand?.name === 'shield';
    const sticks = getItemCount(obs, 'stick');
    const planks = countPlanks(obs);
    const logs = countWoodLogs(obs);
    const foodReserve = countEdibleFood(obs);

    // 1. Stone Sword (Mob defense & animal hunting)
    if (!hasSword) {
      if (cobblestone >= 2 && sticks >= 1 && canAttempt('CRAFT_STONE_SWORD')) {
        candidateGoals.push({
          goalId: 'CRAFT_STONE_SWORD',
          tier: 5,
          reason: 'Craft stone sword for mob defense and food hunting'
        });
      } else if (cobblestone < 2 && canAttempt('MINE_STONE')) {
        candidateGoals.push({
          goalId: 'MINE_STONE',
          tier: 5,
          reason: `Mine cobblestone for stone sword (have ${cobblestone}/2)`
        });
      } else if (sticks < 1 && planks >= 2 && canAttempt('CRAFT_STICKS')) {
        candidateGoals.push({
          goalId: 'CRAFT_STICKS',
          tier: 5,
          reason: 'Craft sticks for stone sword'
        });
      } else if (sticks < 1 && logs > 0 && canAttempt('CRAFT_PLANKS')) {
        candidateGoals.push({
          goalId: 'CRAFT_PLANKS',
          tier: 5,
          reason: 'Craft planks for sticks to make stone sword'
        });
      }
    }
    // 2. Stone Axe (Rapid wood harvesting & Farmer kit)
    else if (!hasAxe) {
      if (cobblestone >= 3 && sticks >= 2 && canAttempt('CRAFT_STONE_AXE')) {
        candidateGoals.push({
          goalId: 'CRAFT_STONE_AXE',
          tier: 5,
          reason: 'Craft stone axe for timber harvesting'
        });
      } else if (cobblestone < 3 && canAttempt('MINE_STONE')) {
        candidateGoals.push({
          goalId: 'MINE_STONE',
          tier: 5,
          reason: `Mine cobblestone for stone axe (have ${cobblestone}/3)`
        });
      } else if (sticks < 2 && planks >= 2 && canAttempt('CRAFT_STICKS')) {
        candidateGoals.push({
          goalId: 'CRAFT_STICKS',
          tier: 5,
          reason: 'Craft sticks for stone axe'
        });
      } else if (sticks < 2 && logs > 0 && canAttempt('CRAFT_PLANKS')) {
        candidateGoals.push({
          goalId: 'CRAFT_PLANKS',
          tier: 5,
          reason: 'Craft planks for sticks to make stone axe'
        });
      }
    }
    // 3. Furnace (Food cooking and ore smelting)
    else if (!hasFurnace) {
      if (cobblestone >= 8 && canAttempt('CRAFT_FURNACE')) {
        candidateGoals.push({
          goalId: 'CRAFT_FURNACE',
          tier: 5,
          reason: 'Craft furnace for cooking and smelting'
        });
      } else if (cobblestone < 8 && canAttempt('MINE_STONE')) {
        candidateGoals.push({
          goalId: 'MINE_STONE',
          tier: 5,
          reason: `Mine cobblestone for furnace (have ${cobblestone}/8)`
        });
      }
    }
    // 4. Food Reserve (>= 16 edible food items for Farmer stage completion)
    else if (foodReserve < 16 && canAttempt('GATHER_FOOD')) {
      candidateGoals.push({
        goalId: 'GATHER_FOOD',
        tier: 5,
        reason: `Gather/hunt food reserve for stage advancement (have ${foodReserve}/16)`
      });
    }
    // 5. Storage Chest (Resource management)
    else if (!hasChest) {
      if (planks >= 8 && canAttempt('CRAFT_CHEST')) {
        candidateGoals.push({
          goalId: 'CRAFT_CHEST',
          tier: 5,
          reason: 'Craft chest to store surplus resources'
        });
      } else if (logs >= 2 && canAttempt('CRAFT_PLANKS')) {
        candidateGoals.push({
          goalId: 'CRAFT_PLANKS',
          tier: 5,
          reason: 'Craft planks for storage chest'
        });
      } else if (logs < 2 && canAttempt('GATHER_WOOD_LOGS')) {
        candidateGoals.push({
          goalId: 'GATHER_WOOD_LOGS',
          tier: 5,
          reason: 'Gather wood logs for storage chest'
        });
      }
    }
    // 6. Shield (Defense equipment)
    else if (!hasShield) {
      const ironIngot = getItemCount(obs, 'iron_ingot');
      if (ironIngot >= 1 && planks >= 6 && canAttempt('CRAFT_SHIELD')) {
        candidateGoals.push({
          goalId: 'CRAFT_SHIELD',
          tier: 5,
          reason: 'Craft shield for projectile and mob defense'
        });
      }
    }
  } else if (pickaxes === 0) {
    // We don't have any pickaxe yet! Follow wooden tool dependency ladder
    const logs = countWoodLogs(obs);
    const planks = countPlanks(obs);
    const sticks = getItemCount(obs, 'stick');
    const hasTable = getItemCount(obs, 'crafting_table') > 0 || (obs?.nearby_resources || []).some(r => r.name === 'crafting_table' && r.distance <= 4);

    if (hasTable && sticks >= 2 && planks >= 3 && canAttempt('CRAFT_WOODEN_PICKAXE')) {
      candidateGoals.push({
        goalId: 'CRAFT_WOODEN_PICKAXE',
        tier: 5,
        reason: `All prerequisites ready for wooden pickaxe (table, sticks, planks)`
      });
    } else if (!hasTable && planks >= 4 && canAttempt('CRAFT_CRAFTING_TABLE')) {
      candidateGoals.push({
        goalId: 'CRAFT_CRAFTING_TABLE',
        tier: 5,
        reason: `Craft crafting table to unlock 3x3 survival tool recipes`
      });
    } else if (sticks < 2 && planks >= 2 && canAttempt('CRAFT_STICKS')) {
      candidateGoals.push({
        goalId: 'CRAFT_STICKS',
        tier: 5,
        reason: `Craft sticks needed for tool crafting`
      });
    } else if (logs > 0 && planks < 4 && canAttempt('CRAFT_PLANKS')) {
      candidateGoals.push({
        goalId: 'CRAFT_PLANKS',
        tier: 5,
        reason: `Convert wood logs into planks for crafting`
      });
    } else if (logs === 0 && planks < 4 && canAttempt('GATHER_WOOD_LOGS')) {
      candidateGoals.push({
        goalId: 'GATHER_WOOD_LOGS',
        tier: 5,
        reason: `No wood or tools; punch tree to gather foundational wood logs`
      });
    }
  }

  // -------------------------------------------------------------
  // TIER 6: Exploration and Upgrade Fallback
  // -------------------------------------------------------------
  if (candidateGoals.length === 0) {
    const logs = countWoodLogs(obs);
    const planks = countPlanks(obs);
    const sticks = getItemCount(obs, 'stick');
    const pickaxes = countTotalPickaxes(obs);

    if (pickaxes === 0 && logs > 0) {
      if (planks < 4 && canAttempt('CRAFT_PLANKS')) {
        candidateGoals.push({
          goalId: 'CRAFT_PLANKS',
          tier: 6,
          reason: 'Convert abundant wood logs into planks for crafting tools'
        });
      } else if (sticks < 2 && planks >= 2 && canAttempt('CRAFT_STICKS')) {
        candidateGoals.push({
          goalId: 'CRAFT_STICKS',
          tier: 6,
          reason: 'Craft sticks from planks for survival tools'
        });
      } else if (canAttempt('CRAFT_WOODEN_PICKAXE')) {
        candidateGoals.push({
          goalId: 'CRAFT_WOODEN_PICKAXE',
          tier: 6,
          reason: 'Craft wooden pickaxe from collected wood materials'
        });
      }
    }

    if (candidateGoals.length === 0) {
      candidateGoals.push({
        goalId: 'GATHER_WOOD_LOGS',
        tier: 6,
        reason: 'General survival maintenance and resource expansion'
      });
    }
  }

  // Select candidate with the lowest tier number (highest priority)
  candidateGoals.sort((a, b) => a.tier - b.tier);
  const selected = candidateGoals[0];

  // Resolve plan dependencies
  const resolvedPlan = resolveGoalPlan(selected.goalId, obs);

  return {
    goalId: selected.goalId,
    tier: selected.tier,
    reason: selected.reason,
    plan: resolvedPlan.length > 0 ? resolvedPlan : [selected.goalId],
    isFallback: selected.tier === 6
  };
}

/**
 * Returns a human-readable status report of survival metrics and current priority.
 * @param {Object} obs
 * @param {Object} [selectedGoal=null]
 * @returns {string}
 */
export function getSurvivalStatusReport(obs, selectedGoal = null) {
  const health = obs?.agent?.health ?? 20;
  const food = obs?.agent?.food ?? 20;
  const time = obs?.time?.timeOfDay ?? obs?.environment?.time_of_day ?? 'unknown';
  const isNight = isNightOrDusk(obs);
  const blocks = countAvailableBuildingBlocks(obs);
  const logs = countWoodLogs(obs);
  const pickaxes = countTotalPickaxes(obs);
  const isSheltered = obs?.shelter_safety?.safe ? 'SAFE' : 'EXPOSED';

  const goalSummary = selectedGoal ? `Current Goal: [Tier ${selectedGoal.tier}] ${selectedGoal.goalId} (${selectedGoal.reason})` : 'No active goal';

  return `[MIKA Survival Status]
• Health: ${health}/20 | Hunger: ${food}/20
• Time: ${time} (${isNight ? 'NIGHT' : 'DAY'}) | Shelter: ${isSheltered}
• Building Blocks: ${blocks} | Logs: ${logs} | Pickaxes: ${pickaxes}
• ${goalSummary}`;
}

export default {
  SURVIVAL_CONFIG,
  GoalExecutionTracker,
  isNightOrDusk,
  evaluateThreatLevel,
  selectContextualGoal,
  getSurvivalStatusReport
};
